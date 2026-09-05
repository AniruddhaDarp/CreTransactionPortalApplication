import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { SharedStack } from '../lib/shared-stack.js';

const ENV = { account: '111111111111', region: 'us-east-2' };

function synth(context: Record<string, unknown> = {}) {
  const app = new App({ context });
  const stack = new SharedStack(app, 'TestShared', { env: ENV });
  return Template.fromStack(stack);
}

describe('SharedStack', () => {
  it('creates the named EventBridge custom bus', () => {
    synth().hasResourceProperties('AWS::Events::EventBus', { Name: 'cre-portal-bus' });
  });

  it('creates exactly one HTTP API with a public GET /v1/health route', () => {
    const t = synth();
    t.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    t.hasResourceProperties('AWS::ApiGatewayV2::Api', { ProtocolType: 'HTTP' });
    t.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'GET /v1/health',
      AuthorizationType: 'NONE',
    });
  });

  it('runs the health Lambda on arm64 nodejs22 with X-Ray active tracing', () => {
    synth().hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      TracingConfig: { Mode: 'Active' },
    });
  });

  it('makes the web bucket fully private', () => {
    synth().hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('fronts the bucket with a CloudFront distribution that SPA-routes to index.html', () => {
    const t = synth();
    t.resourceCountIs('AWS::CloudFront::Distribution', 1);
    t.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: 'index.html',
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({ ErrorCode: 403, ResponseCode: 200, ResponsePagePath: '/index.html' }),
          Match.objectLike({ ErrorCode: 404, ResponseCode: 200, ResponsePagePath: '/index.html' }),
        ]),
      }),
    });
  });

  it('publishes the seven shared SSM parameters', () => {
    synth().resourceCountIs('AWS::SSM::Parameter', 7);
  });

  it('adds an SES sender identity only when -c senderEmail is given', () => {
    synth().resourceCountIs('AWS::SES::EmailIdentity', 0);
    const withEmail = synth({ senderEmail: 'noreply@example.com' });
    withEmail.resourceCountIs('AWS::SES::EmailIdentity', 1);
    withEmail.hasResourceProperties('AWS::SES::EmailIdentity', {
      EmailIdentity: 'noreply@example.com',
    });
  });

  it('has no Cognito resources (owned by the Accounts stack)', () => {
    const t = synth();
    t.resourceCountIs('AWS::Cognito::UserPool', 0);
    expect(t.toJSON()).toBeTypeOf('object');
  });
});
