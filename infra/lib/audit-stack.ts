import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { HttpApi, HttpMethod, HttpRoute, HttpRouteKey } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { EventBus, Match, Rule } from 'aws-cdk-lib/aws-events';
import { SqsQueue } from 'aws-cdk-lib/aws-events-targets';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime, Tracing } from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { Param } from './param-names.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', '..', 'services', 'audit', 'src');

const ROUTES: Array<[HttpMethod, string]> = [
  [HttpMethod.GET, '/v1/deals/{dealId}/audit'],
  [HttpMethod.GET, '/v1/deals/{dealId}/audit/export'],
];

/**
 * AuditStack — the append-only trail. Consumes **every** `cre.*` event and
 * writes one immutable row per event.
 *
 * Append-only is enforced by IAM, not just code: the consumer's role has
 * `dynamodb:PutItem` on the audit table and nothing else — no UpdateItem, no
 * DeleteItem, no BatchWriteItem. The `member.*` projection it also maintains
 * needs UpdateItem, so it lives in a **separate** table the consumer may
 * read/write freely; the audit log itself stays untouchable.
 */
export class AuditStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, {
      ...props,
      description: 'CRE Transaction Portal — Audit service (append-only trail, scoped read + export)',
    });

    const httpApiId = StringParameter.valueForStringParameter(this, Param.httpApiId);
    const busArn = StringParameter.valueForStringParameter(this, Param.busArn);
    const issuer = StringParameter.valueForStringParameter(this, Param.userPoolIssuer);
    const clientId = StringParameter.valueForStringParameter(this, Param.userPoolClientId);

    const auditTable = new Table(this, 'AuditTable', {
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl', // reserved for a future retention policy
    });

    // The `member.*` projection — mutable, so it is kept out of the append-only table.
    const membershipTable = new Table(this, 'MembershipTable', {
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const bundling = { format: OutputFormat.ESM, mainFields: ['module', 'main'], target: 'node22' };
    const env = {
      AUDIT_TABLE: auditTable.tableName,
      AUDIT_MEMBERSHIP_TABLE: membershipTable.tableName,
    };

    // --- API handler (read + export) ---------------------------------
    const apiLogs = new LogGroup(this, 'ApiFnLogs', {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const apiFn = new NodejsFunction(this, 'ApiFn', {
      entry: path.join(SRC, 'api.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      tracing: Tracing.ACTIVE,
      logGroup: apiLogs,
      timeout: Duration.seconds(15),
      environment: env,
      bundling,
    });
    auditTable.grantReadData(apiFn);
    membershipTable.grantReadData(apiFn);

    const httpApi = HttpApi.fromHttpApiAttributes(this, 'EdgeApi', { httpApiId });
    const authorizer = new HttpJwtAuthorizer('JwtAuthorizer', issuer, {
      authorizerName: 'cre-portal-jwt-audit',
      identitySource: ['$request.header.Authorization'],
      jwtAudience: [clientId],
    });
    const integration = new HttpLambdaIntegration('AuditIntegration', apiFn);
    for (const [method, routePath] of ROUTES) {
      new HttpRoute(this, `Route_${method}_${routePath.replace(/[^A-Za-z0-9]/g, '_')}`, {
        httpApi,
        routeKey: HttpRouteKey.with(routePath, method),
        integration,
        authorizer,
      });
    }

    // --- event consumer (every cre.* event) -------------------------
    const dlq = new Queue(this, 'ConsumerDLQ', { retentionPeriod: Duration.days(14) });
    const queue = new Queue(this, 'ConsumerQueue', {
      visibilityTimeout: Duration.seconds(120),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
    });

    new Rule(this, 'ConsumerRule', {
      eventBus: EventBus.fromEventBusArn(this, 'BusForRule', busArn),
      eventPattern: { source: Match.prefix('cre.') },
      targets: [new SqsQueue(queue)],
    });

    const consumerLogs = new LogGroup(this, 'ConsumerFnLogs', {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const consumerFn = new NodejsFunction(this, 'ConsumerFn', {
      entry: path.join(SRC, 'consumer.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      tracing: Tracing.ACTIVE,
      logGroup: consumerLogs,
      timeout: Duration.seconds(30),
      environment: env,
      bundling,
    });
    // Append-only: PutItem and nothing else on the audit table.
    consumerFn.addToRolePolicy(
      new PolicyStatement({ actions: ['dynamodb:PutItem'], resources: [auditTable.tableArn] }),
    );
    // The membership projection is a separate, mutable table.
    membershipTable.grantReadWriteData(consumerFn);
    consumerFn.addEventSource(
      new SqsEventSource(queue, {
        batchSize: 10,
        maxBatchingWindow: Duration.seconds(5),
        reportBatchItemFailures: true,
      }),
    );

    new CfnOutput(this, 'AuditTableName', { value: auditTable.tableName });
    new CfnOutput(this, 'AuditMembershipTableName', { value: membershipTable.tableName });
    new CfnOutput(this, 'AuditConsumerQueueUrl', { value: queue.queueUrl });
  }
}
