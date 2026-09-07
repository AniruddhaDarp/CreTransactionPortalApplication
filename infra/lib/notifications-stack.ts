import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { HttpApi, HttpMethod, HttpRoute, HttpRouteKey } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { EventBus, Rule } from 'aws-cdk-lib/aws-events';
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
const SRC = path.join(HERE, '..', '..', 'services', 'notifications', 'src');

const ROUTES: Array<[HttpMethod, string]> = [
  [HttpMethod.GET, '/v1/notifications'],
  [HttpMethod.POST, '/v1/notifications/read'],
];

/** The subset of the bus this service reacts to. Matched by detail-type only
 *  (events come from several sources). */
const CONSUMED_EVENTS = [
  'account.created',
  'member.invited',
  'member.joined',
  'member.role_changed',
  'member.removed',
  'handshake.requested',
  'handshake.approved',
  'handshake.rejected',
  'message.posted',
  'docrequest.created',
  'docrequest.fulfilled',
  'docrequest.declined',
  'stage.advanced',
  'deal.status_changed',
  'thread.converted',
  'payment.confirmed',
  'payment.voided',
];

/**
 * NotificationsStack — the in-app notification centre + (flag-gated) email.
 * Consumer fans each event out to a recipient set and writes one row per
 * recipient; the API serves the bell and mark-read. Email dispatch (SESv2) is
 * wired but a no-op until `NOTIFY_EMAIL_FROM` is set to a verified sender.
 */
export class NotificationsStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, {
      ...props,
      description: 'CRE Transaction Portal — Notifications service (bell + unread + action-required email)',
    });

    const httpApiId = StringParameter.valueForStringParameter(this, Param.httpApiId);
    const busArn = StringParameter.valueForStringParameter(this, Param.busArn);
    const busName = StringParameter.valueForStringParameter(this, Param.busName);
    const issuer = StringParameter.valueForStringParameter(this, Param.userPoolIssuer);
    const clientId = StringParameter.valueForStringParameter(this, Param.userPoolClientId);
    const distributionDomain = StringParameter.valueForStringParameter(
      this,
      Param.distributionDomain,
    );

    const table = new Table(this, 'Table', {
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl',
    });

    const bundling = { format: OutputFormat.ESM, mainFields: ['module', 'main'], target: 'node22' };

    // --- API handler (bell + mark-read) -----------------------------
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
      timeout: Duration.seconds(10),
      environment: { NOTIFICATIONS_TABLE: table.tableName },
      bundling,
    });
    table.grantReadWriteData(apiFn);

    const httpApi = HttpApi.fromHttpApiAttributes(this, 'EdgeApi', { httpApiId });
    const authorizer = new HttpJwtAuthorizer('JwtAuthorizer', issuer, {
      authorizerName: 'cre-portal-jwt-notifications',
      identitySource: ['$request.header.Authorization'],
      jwtAudience: [clientId],
    });
    const integration = new HttpLambdaIntegration('NotificationsIntegration', apiFn);
    for (const [method, routePath] of ROUTES) {
      new HttpRoute(this, `Route_${method}_${routePath.replace(/[^A-Za-z0-9]/g, '_')}`, {
        httpApi,
        routeKey: HttpRouteKey.with(routePath, method),
        integration,
        authorizer,
      });
    }

    // --- event consumer -------------------------------------------
    const dlq = new Queue(this, 'ConsumerDLQ', { retentionPeriod: Duration.days(14) });
    const queue = new Queue(this, 'ConsumerQueue', {
      visibilityTimeout: Duration.seconds(90),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
    });

    new Rule(this, 'ConsumerRule', {
      eventBus: EventBus.fromEventBusArn(this, 'BusForRule', busArn),
      eventPattern: { detailType: CONSUMED_EVENTS },
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
      environment: {
        NOTIFICATIONS_TABLE: table.tableName,
        EVENT_BUS_NAME: busName,
        WEB_ORIGIN: `https://${distributionDomain}`,
        NOTIFY_EMAIL_FROM: '', // set to a verified SES sender to enable email
      },
      bundling,
    });
    table.grantReadWriteData(consumerFn);
    EventBus.fromEventBusArn(this, 'BusForPut', busArn).grantPutEventsTo(consumerFn);
    // Inert while NOTIFY_EMAIL_FROM is unset; present so enabling email needs no redeploy of policy.
    consumerFn.addToRolePolicy(
      new PolicyStatement({ actions: ['ses:SendEmail'], resources: ['*'] }),
    );
    consumerFn.addEventSource(
      new SqsEventSource(queue, {
        batchSize: 10,
        maxBatchingWindow: Duration.seconds(5),
        reportBatchItemFailures: true,
      }),
    );

    new CfnOutput(this, 'NotificationsTableName', { value: table.tableName });
    new CfnOutput(this, 'NotificationsConsumerQueueUrl', { value: queue.queueUrl });
  }
}
