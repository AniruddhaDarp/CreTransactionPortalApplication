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
import { BlockPublicAccess, Bucket, HttpMethods } from 'aws-cdk-lib/aws-s3';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { Param } from './param-names.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', '..', 'services', 'documents', 'src');

const ROUTES: Array<[HttpMethod, string]> = [
  [HttpMethod.GET, '/v1/deals/{dealId}/documents'],
  [HttpMethod.POST, '/v1/deals/{dealId}/documents'],
  [HttpMethod.GET, '/v1/deals/{dealId}/documents/{docId}'],
  [HttpMethod.POST, '/v1/deals/{dealId}/documents/{docId}/versions'],
  [HttpMethod.GET, '/v1/deals/{dealId}/documents/{docId}/versions/{n}/download'],
  [HttpMethod.GET, '/v1/deals/{dealId}/documents/{docId}/versions/{n}/view'],
  [HttpMethod.POST, '/v1/deals/{dealId}/documents/{docId}/promote'],
  [HttpMethod.DELETE, '/v1/deals/{dealId}/documents/{docId}'],
  [HttpMethod.GET, '/v1/deals/{dealId}/doc-requests'],
  [HttpMethod.POST, '/v1/deals/{dealId}/doc-requests'],
  [HttpMethod.POST, '/v1/deals/{dealId}/doc-requests/{reqId}/fulfill'],
  [HttpMethod.POST, '/v1/deals/{dealId}/doc-requests/{reqId}/decline'],
  [HttpMethod.POST, '/v1/deals/{dealId}/doc-requests/{reqId}/cancel'],
  // e-signature (Module 12, stretch)
  [HttpMethod.POST, '/v1/deals/{dealId}/documents/{docId}/signature'],
  [HttpMethod.GET, '/v1/deals/{dealId}/documents/{docId}/signature'],
  [HttpMethod.POST, '/v1/deals/{dealId}/documents/{docId}/signature/{envId}/sign'],
  [HttpMethod.POST, '/v1/deals/{dealId}/documents/{docId}/signature/{envId}/void'],
];

/** `member.*` feeds the local projection; `handshake.approved` drives the delete saga. */
const CONSUMED_EVENTS = [
  'member.joined',
  'member.role_changed',
  'member.removed',
  'handshake.approved',
];

/**
 * DocumentsStack — the versioned, scope- and category-permissioned document
 * room. Same consumer shape as ChatStack: an API Lambda on the shared HTTP API
 * plus an SQS-triggered consumer. Adds a private S3 bucket; files are uploaded
 * and fetched directly by the browser through short-lived presigned URLs, so the
 * bucket carries a CORS rule for the SPA origins.
 */
export class DocumentsStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, {
      ...props,
      description: 'CRE Transaction Portal — Documents service (versioned room, requests, delete saga)',
    });

    const httpApiId = StringParameter.valueForStringParameter(this, Param.httpApiId);
    const busName = StringParameter.valueForStringParameter(this, Param.busName);
    const busArn = StringParameter.valueForStringParameter(this, Param.busArn);
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
    });

    const bucket = new Bucket(this, 'DocsBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      cors: [
        {
          allowedMethods: [HttpMethods.PUT, HttpMethods.GET],
          allowedOrigins: [`https://${distributionDomain}`, 'http://localhost:5173'],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: 3000,
        },
      ],
    });

    const bundling = { format: OutputFormat.ESM, mainFields: ['module', 'main'], target: 'node22' };

    // --- API handler --------------------------------------------------
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
      environment: {
        DOCUMENTS_TABLE: table.tableName,
        DOCS_BUCKET: bucket.bucketName,
        EVENT_BUS_NAME: busName,
        // e-signature (Module 12): 'fake' drives the demo end-to-end in-process.
        // Set to 'docusign' + the DOCUSIGN_* vars (from a Secret) to go live.
        ESIGN_PROVIDER: 'fake',
        DOCUSIGN_OAUTH_BASE: '',
        DOCUSIGN_REST_BASE: '',
        DOCUSIGN_INTEGRATION_KEY: '',
        DOCUSIGN_USER_ID: '',
        DOCUSIGN_ACCOUNT_ID: '',
        DOCUSIGN_PRIVATE_KEY: '',
      },
      bundling,
    });
    table.grantReadWriteData(apiFn);
    bucket.grantReadWrite(apiFn);
    EventBus.fromEventBusArn(this, 'Bus', busArn).grantPutEventsTo(apiFn);

    const httpApi = HttpApi.fromHttpApiAttributes(this, 'EdgeApi', { httpApiId });
    const authorizer = new HttpJwtAuthorizer('JwtAuthorizer', issuer, {
      authorizerName: 'cre-portal-jwt-documents',
      identitySource: ['$request.header.Authorization'],
      jwtAudience: [clientId],
    });
    const integration = new HttpLambdaIntegration('DocumentsIntegration', apiFn);
    for (const [method, routePath] of ROUTES) {
      new HttpRoute(this, `Route_${method}_${routePath.replace(/[^A-Za-z0-9]/g, '_')}`, {
        httpApi,
        routeKey: HttpRouteKey.with(routePath, method),
        integration,
        authorizer,
      });
    }

    // --- event consumer --------------------------------------------
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
      environment: { DOCUMENTS_TABLE: table.tableName, EVENT_BUS_NAME: busName },
      bundling,
    });
    table.grantReadWriteData(consumerFn);
    EventBus.fromEventBusArn(this, 'BusForConsumer', busArn).grantPutEventsTo(consumerFn);
    consumerFn.addEventSource(
      new SqsEventSource(queue, {
        batchSize: 10,
        maxBatchingWindow: Duration.seconds(5),
        reportBatchItemFailures: true,
      }),
    );

    new CfnOutput(this, 'DocumentsTableName', { value: table.tableName });
    new CfnOutput(this, 'DocsBucketName', { value: bucket.bucketName });
    new CfnOutput(this, 'DocumentsConsumerQueueUrl', { value: queue.queueUrl });
  }
}
