import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import {
  HttpApi,
  HttpMethod,
  HttpRoute,
  HttpRouteKey,
} from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import {
  AccountRecovery,
  OAuthScope,
  UserPool,
  UserPoolClient,
  UserPoolClientIdentityProvider,
  UserPoolDomain,
  UserPoolOperation,
} from 'aws-cdk-lib/aws-cognito';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { EventBus } from 'aws-cdk-lib/aws-events';
import { Architecture, Runtime, Tracing } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { Param } from './param-names.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ACCOUNTS_SRC = path.join(HERE, '..', '..', 'services', 'accounts', 'src');

/**
 * AccountsStack — the Accounts service **and** all Cognito identity resources.
 *
 * Owns the user pool, the public SPA app client, the hosted-UI domain, the
 * post-confirmation trigger, and the `accounts` table. Reads SharedStack's
 * bus / edge-API identifiers from SSM. Each service stack (this one included)
 * builds its own `HttpJwtAuthorizer` from the pool issuer + client id — the
 * config is identical everywhere, so there is no shared authorizer resource.
 */
export class AccountsStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, {
      ...props,
      description: 'CRE Transaction Portal — Accounts service + Cognito identity',
    });

    const httpApiId = StringParameter.valueForStringParameter(this, Param.httpApiId);
    const httpApiEndpoint = StringParameter.valueForStringParameter(this, Param.httpApiEndpoint);
    const busName = StringParameter.valueForStringParameter(this, Param.busName);
    const busArn = StringParameter.valueForStringParameter(this, Param.busArn);
    const distributionDomain = StringParameter.valueForStringParameter(
      this,
      Param.distributionDomain,
    );

    // --- data ---------------------------------------------------------------
    const table = new Table(this, 'Table', {
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    table.addGlobalSecondaryIndex({
      indexName: 'gsi-email',
      partitionKey: { name: 'GSI1PK', type: AttributeType.STRING },
    });

    // --- Lambdas ----------------------------------------------------------
    const bus = EventBus.fromEventBusArn(this, 'Bus', busArn);

    const fn = (name: string, entry: string) => {
      const logs = new LogGroup(this, `${name}Logs`, {
        retention: RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      });
      return new NodejsFunction(this, name, {
        entry: path.join(ACCOUNTS_SRC, entry),
        handler: 'handler',
        runtime: Runtime.NODEJS_22_X,
        architecture: Architecture.ARM_64,
        tracing: Tracing.ACTIVE,
        logGroup: logs,
        timeout: Duration.seconds(10),
        environment: { ACCOUNTS_TABLE: table.tableName, EVENT_BUS_NAME: busName },
        bundling: { format: OutputFormat.ESM, mainFields: ['module', 'main'], target: 'node22' },
      });
    };

    const meFn = fn('MeFn', 'handler.ts');
    table.grantReadWriteData(meFn);

    const postConfirmFn = fn('PostConfirmFn', 'post-confirmation.ts');
    table.grantWriteData(postConfirmFn);
    bus.grantPutEventsTo(postConfirmFn);

    // --- Cognito -------------------------------------------------------
    const userPool = new UserPool(this, 'UserPool', {
      userPoolName: 'cre-portal-users',
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
        fullname: { required: false, mutable: true },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    userPool.addTrigger(UserPoolOperation.POST_CONFIRMATION, postConfirmFn);

    const client = new UserPoolClient(this, 'SpaClient', {
      userPool,
      userPoolClientName: 'cre-portal-spa',
      generateSecret: false, // public SPA client — never a secret
      // The browser uses the hosted UI (auth-code + PKCE). `userPassword` is
      // additionally enabled for the seed script and E2E tests to log in
      // programmatically; a production client would be SRP-only.
      authFlows: { userSrp: true, userPassword: true },
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      supportedIdentityProviders: [UserPoolClientIdentityProvider.COGNITO],
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      oAuth: {
        flows: { authorizationCodeGrant: true }, // auth-code + PKCE, no implicit
        scopes: [OAuthScope.OPENID, OAuthScope.EMAIL, OAuthScope.PROFILE],
        callbackUrls: [`https://${distributionDomain}/`, 'http://localhost:5173/'],
        logoutUrls: [`https://${distributionDomain}/`, 'http://localhost:5173/'],
      },
    });

    const hostedUi = new UserPoolDomain(this, 'HostedUi', {
      userPool,
      cognitoDomain: { domainPrefix: `cre-portal-${this.account}` },
    });
    const hostedUiFqdn = `${hostedUi.domainName}.auth.${this.region}.amazoncognito.com`;

    // --- routes (JWT-authorized) ------------------------------------
    const httpApi = HttpApi.fromHttpApiAttributes(this, 'EdgeApi', {
      httpApiId,
      apiEndpoint: httpApiEndpoint,
    });
    // One JWT authorizer per service stack (identical issuer/audience). API
    // Gateway requires unique authorizer *names* on a shared API, hence the
    // per-service suffix.
    const authorizer = new HttpJwtAuthorizer('JwtAuthorizer', userPool.userPoolProviderUrl, {
      authorizerName: 'cre-portal-jwt-accounts',
      identitySource: ['$request.header.Authorization'],
      jwtAudience: [client.userPoolClientId],
    });
    for (const method of [HttpMethod.GET, HttpMethod.PUT]) {
      new HttpRoute(this, `MeRoute${method}`, {
        httpApi,
        routeKey: HttpRouteKey.with('/v1/me', method),
        integration: new HttpLambdaIntegration(`MeIntegration${method}`, meFn),
        authorizer,
      });
    }

    // --- SSM + outputs -----------------------------------------------
    const params: Record<string, string> = {
      [Param.userPoolId]: userPool.userPoolId,
      [Param.userPoolClientId]: client.userPoolClientId,
      [Param.userPoolIssuer]: userPool.userPoolProviderUrl,
      [Param.hostedUiDomain]: hostedUiFqdn,
    };
    for (const [parameterName, stringValue] of Object.entries(params)) {
      new StringParameter(this, 'Param' + parameterName.replace(/[^A-Za-z0-9]/g, ''), {
        parameterName,
        stringValue,
      });
    }

    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: client.userPoolClientId });
    new CfnOutput(this, 'HostedUiUrl', { value: `https://${hostedUiFqdn}` });
    new CfnOutput(this, 'MeEndpoint', { value: `${httpApiEndpoint}/v1/me` });
  }
}
