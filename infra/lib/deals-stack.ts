import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { HttpApi, HttpMethod, HttpRoute, HttpRouteKey } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { EventBus } from 'aws-cdk-lib/aws-events';
import { Architecture, Runtime, Tracing } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { Param } from './param-names.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEALS_SRC = path.join(HERE, '..', '..', 'services', 'deals', 'src');

type RouteSpec = [HttpMethod, string];

const ROUTES: RouteSpec[] = [
  [HttpMethod.POST, '/v1/deals'],
  [HttpMethod.GET, '/v1/deals'],
  [HttpMethod.GET, '/v1/deals/{dealId}'],
  [HttpMethod.PATCH, '/v1/deals/{dealId}'],
  [HttpMethod.POST, '/v1/deals/{dealId}/status'],
  [HttpMethod.GET, '/v1/deals/{dealId}/dashboard'],
  [HttpMethod.GET, '/v1/deals/{dealId}/members'],
  [HttpMethod.GET, '/v1/deals/{dealId}/invites'],
  [HttpMethod.POST, '/v1/deals/{dealId}/invites'],
  [HttpMethod.DELETE, '/v1/deals/{dealId}/invites/{token}'],
  [HttpMethod.GET, '/v1/deals/{dealId}/invites/{token}'],
  [HttpMethod.POST, '/v1/deals/{dealId}/invites/{token}/accept'],
  [HttpMethod.PATCH, '/v1/deals/{dealId}/members/{userId}'],
  [HttpMethod.DELETE, '/v1/deals/{dealId}/members/{userId}'],
];

/**
 * DealsStack — the Deals service: deal records, membership, invitations.
 * Milestones + checklists + the handshake state machine are added in Module 5
 * (same stack, same table). Reads SharedStack + AccountsStack identifiers from
 * SSM; owns nothing other services read.
 */
export class DealsStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, {
      ...props,
      description: 'CRE Transaction Portal — Deals service (deals, membership, invitations)',
    });

    const httpApiId = StringParameter.valueForStringParameter(this, Param.httpApiId);
    const httpApiEndpoint = StringParameter.valueForStringParameter(this, Param.httpApiEndpoint);
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
    table.addGlobalSecondaryIndex({
      indexName: 'gsi1',
      partitionKey: { name: 'GSI1PK', type: AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: AttributeType.STRING },
    });
    table.addGlobalSecondaryIndex({
      indexName: 'gsi2',
      partitionKey: { name: 'GSI2PK', type: AttributeType.STRING },
      sortKey: { name: 'GSI2SK', type: AttributeType.STRING },
    });

    const logs = new LogGroup(this, 'DealsFnLogs', {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const dealsFn = new NodejsFunction(this, 'DealsFn', {
      entry: path.join(DEALS_SRC, 'deals.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      tracing: Tracing.ACTIVE,
      logGroup: logs,
      timeout: Duration.seconds(10),
      environment: {
        DEALS_TABLE: table.tableName,
        EVENT_BUS_NAME: busName,
        WEB_ORIGIN: `https://${distributionDomain}`,
      },
      bundling: { format: OutputFormat.ESM, mainFields: ['module', 'main'], target: 'node22' },
    });
    table.grantReadWriteData(dealsFn);
    EventBus.fromEventBusArn(this, 'Bus', busArn).grantPutEventsTo(dealsFn);

    const httpApi = HttpApi.fromHttpApiAttributes(this, 'EdgeApi', {
      httpApiId,
      apiEndpoint: httpApiEndpoint,
    });
    const authorizer = new HttpJwtAuthorizer('JwtAuthorizer', issuer, {
      authorizerName: 'cre-portal-jwt-deals',
      identitySource: ['$request.header.Authorization'],
      jwtAudience: [clientId],
    });
    const integration = new HttpLambdaIntegration('DealsIntegration', dealsFn);

    for (const [method, routePath] of ROUTES) {
      new HttpRoute(this, `Route_${method}_${routePath.replace(/[^A-Za-z0-9]/g, '_')}`, {
        httpApi,
        routeKey: HttpRouteKey.with(routePath, method),
        integration,
        authorizer,
      });
    }

    new CfnOutput(this, 'DealsTableName', { value: table.tableName });
    new CfnOutput(this, 'DealsEndpoint', { value: `${httpApiEndpoint}/v1/deals` });
  }
}
