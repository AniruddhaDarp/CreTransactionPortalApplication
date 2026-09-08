import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { HttpApi, HttpMethod, HttpRoute, HttpRouteKey } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { EventBus, Rule } from 'aws-cdk-lib/aws-events';
import { SqsQueue } from 'aws-cdk-lib/aws-events-targets';
import { Architecture, Runtime, Tracing } from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { Param } from './param-names.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', '..', 'services', 'chat', 'src');

const ROUTES: Array<[HttpMethod, string]> = [
  [HttpMethod.GET, '/v1/deals/{dealId}/threads'],
  [HttpMethod.POST, '/v1/deals/{dealId}/threads'],
  [HttpMethod.POST, '/v1/deals/{dealId}/threads/{threadId}/convert'],
  [HttpMethod.DELETE, '/v1/deals/{dealId}/threads/{threadId}'],
  [HttpMethod.GET, '/v1/deals/{dealId}/threads/{threadId}/messages'],
  [HttpMethod.POST, '/v1/deals/{dealId}/threads/{threadId}/messages'],
  [HttpMethod.PATCH, '/v1/deals/{dealId}/threads/{threadId}/messages/{msgId}'],
  [HttpMethod.DELETE, '/v1/deals/{dealId}/threads/{threadId}/messages/{msgId}'],
  [HttpMethod.GET, '/v1/deals/{dealId}/threads/{threadId}/messages/{msgId}/receipts'],
  [HttpMethod.POST, '/v1/deals/{dealId}/threads/{threadId}/read'],
  [HttpMethod.GET, '/v1/deals/{dealId}/activity'],
];

/** Events the chat consumer needs: `member.*` for the projection, the rest for the feed. */
const CONSUMED_EVENTS = [
  'member.joined',
  'member.role_changed',
  'member.removed',
  'stage.advanced',
  'handshake.approved',
  'handshake.rejected',
  'deal.status_changed',
];

/**
 * ChatStack — the first *consumer* service. Two Lambdas: an API handler on the
 * shared HTTP API, and an SQS-triggered consumer fed by an EventBridge rule on
 * `cre-portal-bus`. Modules 7–9 copy this shape.
 */
export class ChatStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, {
      ...props,
      description: 'CRE Transaction Portal — Chat service (threads, messages, receipts, activity)',
    });

    const httpApiId = StringParameter.valueForStringParameter(this, Param.httpApiId);
    const busName = StringParameter.valueForStringParameter(this, Param.busName);
    const busArn = StringParameter.valueForStringParameter(this, Param.busArn);
    const issuer = StringParameter.valueForStringParameter(this, Param.userPoolIssuer);
    const clientId = StringParameter.valueForStringParameter(this, Param.userPoolClientId);

    const table = new Table(this, 'Table', {
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl',
    });

    const bundling = {
      format: OutputFormat.ESM,
      mainFields: ['module', 'main'],
      target: 'node22',
    };

    // --- API handler ----------------------------------------------------
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
      environment: { CHAT_TABLE: table.tableName, EVENT_BUS_NAME: busName },
      bundling,
    });
    table.grantReadWriteData(apiFn);
    EventBus.fromEventBusArn(this, 'Bus', busArn).grantPutEventsTo(apiFn);

    const httpApi = HttpApi.fromHttpApiAttributes(this, 'EdgeApi', { httpApiId });
    const authorizer = new HttpJwtAuthorizer('JwtAuthorizer', issuer, {
      authorizerName: 'cre-portal-jwt-chat',
      identitySource: ['$request.header.Authorization'],
      jwtAudience: [clientId],
    });
    const integration = new HttpLambdaIntegration('ChatIntegration', apiFn);
    for (const [method, routePath] of ROUTES) {
      new HttpRoute(this, `Route_${method}_${routePath.replace(/[^A-Za-z0-9]/g, '_')}`, {
        httpApi,
        routeKey: HttpRouteKey.with(routePath, method),
        integration,
        authorizer,
      });
    }

    // --- event consumer ---------------------------------------------
    const dlq = new Queue(this, 'ConsumerDLQ', { retentionPeriod: Duration.days(14) });
    const queue = new Queue(this, 'ConsumerQueue', {
      visibilityTimeout: Duration.seconds(90),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
    });

    new Rule(this, 'ConsumerRule', {
      eventBus: EventBus.fromEventBusArn(this, 'BusForRule', busArn),
      eventPattern: { source: ['cre.deals'], detailType: CONSUMED_EVENTS },
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
      timeout: Duration.seconds(15),
      environment: { CHAT_TABLE: table.tableName },
      bundling,
    });
    table.grantReadWriteData(consumerFn);
    consumerFn.addEventSource(
      new SqsEventSource(queue, {
        batchSize: 10,
        maxBatchingWindow: Duration.seconds(5),
        reportBatchItemFailures: true,
      }),
    );

    new CfnOutput(this, 'ChatTableName', { value: table.tableName });
    new CfnOutput(this, 'ConsumerQueueUrl', { value: queue.queueUrl });
  }
}
