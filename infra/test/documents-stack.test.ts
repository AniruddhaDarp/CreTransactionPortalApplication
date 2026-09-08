import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, it } from 'vitest';
import { DocumentsStack } from '../lib/documents-stack.js';

let t: Template;

beforeAll(() => {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  t = Template.fromStack(
    new DocumentsStack(app, 'TestDocuments', {
      env: { account: '111111111111', region: 'us-east-2' },
    }),
  );
});

describe('DocumentsStack', () => {
  it('creates a pay-per-request table', () => {
    t.hasResourceProperties('AWS::DynamoDB::Table', { BillingMode: 'PAY_PER_REQUEST' });
  });

  it('creates a private bucket with public access blocked and a CORS rule for PUT/GET', () => {
    t.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      CorsConfiguration: {
        CorsRules: Match.arrayWith([
          Match.objectLike({ AllowedMethods: Match.arrayWith(['PUT', 'GET']) }),
        ]),
      },
    });
  });

  it('runs its Lambdas on nodejs22/arm64 with X-Ray active', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      TracingConfig: { Mode: 'Active' },
    });
  });

  it('routes member.* + handshake.approved from the bus into an SQS queue with a DLQ', () => {
    t.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: {
        source: ['cre.deals'],
        'detail-type': Match.arrayWith(['member.joined', 'handshake.approved']),
      },
    });
    t.resourceCountIs('AWS::SQS::Queue', 2); // consumer queue + DLQ
    t.hasResourceProperties('AWS::SQS::Queue', { RedrivePolicy: { maxReceiveCount: 5 } });
  });

  it('wires the queue as an event source with partial-batch responses', () => {
    t.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      FunctionResponseTypes: ['ReportBatchItemFailures'],
    });
  });

  it('registers the 18 JWT-authorized document routes', () => {
    t.resourceCountIs('AWS::ApiGatewayV2::Route', 18);
    t.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', { AuthorizerType: 'JWT' });
    for (const rk of [
      'POST /v1/deals/{dealId}/documents',
      'GET /v1/deals/{dealId}/documents/{docId}/versions/{n}/download',
      'DELETE /v1/deals/{dealId}/documents/{docId}',
      'POST /v1/deals/{dealId}/doc-requests/{reqId}/fulfill',
      'POST /v1/deals/{dealId}/documents/{docId}/signature',
      'POST /v1/deals/{dealId}/documents/{docId}/signature/{envId}/sign',
    ]) {
      t.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: rk, AuthorizationType: 'JWT' });
    }
  });
});
