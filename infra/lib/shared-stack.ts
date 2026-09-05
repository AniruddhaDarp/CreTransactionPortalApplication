import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { CorsHttpMethod, HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import {
  CachePolicy,
  Distribution,
  HttpVersion,
  PriceClass,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { EventBus } from 'aws-cdk-lib/aws-events';
import { Architecture, Code, Function as LambdaFunction, Runtime, Tracing } from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { EmailIdentity, Identity } from 'aws-cdk-lib/aws-ses';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { Param } from './param-names.js';

/**
 * SharedStack — cross-service infrastructure the whole platform depends on.
 *
 * Owns: the EventBridge custom bus, the single edge HTTP API (+ a public
 * `GET /v1/health` smoke route), and SPA hosting (private S3 + CloudFront/OAC).
 * Optionally registers an SES sender identity when `-c senderEmail=` is given.
 *
 * Does NOT own Cognito — the Accounts stack (Module 3) owns the user pool,
 * app client, hosted-UI domain, post-confirmation trigger, and the shared JWT
 * authorizer, to avoid a circular stack dependency. Cross-stack wiring is done
 * through SSM parameters (see `param-names.ts`), keeping every service stack
 * independently deployable.
 */
export class SharedStack extends Stack {
  readonly bus: EventBus;
  readonly httpApi: HttpApi;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, {
      ...props,
      description:
        'CRE Transaction Portal — shared infrastructure (event bus, edge API, web hosting)',
    });

    // --- Async backbone -----------------------------------------------------
    this.bus = new EventBus(this, 'Bus', { eventBusName: 'cre-portal-bus' });

    // --- Edge HTTP API ----------------------------------------------------
    // Service stacks add their own routes to this API by id (via SSM).
    this.httpApi = new HttpApi(this, 'EdgeApi', {
      apiName: 'cre-portal-edge',
      description: 'CRE Transaction Portal — single edge HTTP API',
      corsPreflight: {
        // Tightened to the CloudFront domain in a later module; bearer-token
        // auth only (no cookies), so a wildcard origin is acceptable for now.
        allowOrigins: ['*'],
        allowMethods: [CorsHttpMethod.ANY],
        allowHeaders: ['authorization', 'content-type', 'x-correlation-id'],
      },
    });

    const healthLog = new LogGroup(this, 'HealthFnLogs', {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const healthFn = new LambdaFunction(this, 'HealthFn', {
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      handler: 'index.handler',
      tracing: Tracing.ACTIVE,
      logGroup: healthLog,
      code: Code.fromInline(
        `exports.handler = async () => ({
  statusCode: 200,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ status: 'ok', service: 'shared', ts: new Date().toISOString() }),
});`,
      ),
    });
    this.httpApi.addRoutes({
      path: '/v1/health',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('HealthIntegration', healthFn),
    });

    // --- SPA hosting ------------------------------------------------------
    const webBucket = new Bucket(this, 'WebBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const distribution = new Distribution(this, 'WebDistribution', {
      comment: 'CRE Transaction Portal SPA',
      defaultRootObject: 'index.html',
      priceClass: PriceClass.PRICE_CLASS_100,
      httpVersion: HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        compress: true,
      },
      // SPA client-side routing: unknown paths fall back to index.html.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.minutes(5) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.minutes(5) },
      ],
    });

    // --- Optional SES sender identity ----------------------------------
    const senderEmail = this.node.tryGetContext('senderEmail') as string | undefined;
    if (senderEmail) {
      new EmailIdentity(this, 'SenderIdentity', { identity: Identity.email(senderEmail) });
    }

    // --- Cross-stack references (SSM) --------------------------------
    const shared: Record<string, string> = {
      [Param.busName]: this.bus.eventBusName,
      [Param.busArn]: this.bus.eventBusArn,
      [Param.httpApiId]: this.httpApi.apiId,
      [Param.httpApiEndpoint]: this.httpApi.apiEndpoint,
      [Param.webBucketName]: webBucket.bucketName,
      [Param.distributionId]: distribution.distributionId,
      [Param.distributionDomain]: distribution.distributionDomainName,
    };
    for (const [parameterName, stringValue] of Object.entries(shared)) {
      const cid = 'Param' + parameterName.replace(/[^A-Za-z0-9]/g, '');
      new StringParameter(this, cid, { parameterName, stringValue });
    }

    // --- Outputs -------------------------------------------------------
    new CfnOutput(this, 'BusName', { value: this.bus.eventBusName });
    new CfnOutput(this, 'HttpApiEndpoint', { value: this.httpApi.apiEndpoint });
    new CfnOutput(this, 'HealthUrl', { value: `${this.httpApi.apiEndpoint}/v1/health` });
    new CfnOutput(this, 'DistributionDomain', {
      value: `https://${distribution.distributionDomainName}`,
    });
    new CfnOutput(this, 'WebBucketName', { value: webBucket.bucketName });
  }
}
