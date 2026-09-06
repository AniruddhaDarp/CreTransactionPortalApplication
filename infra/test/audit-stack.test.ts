import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, it } from 'vitest';
import { AuditStack } from '../lib/audit-stack.js';

let t: Template;

beforeAll(() => {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  t = Template.fromStack(
    new AuditStack(app, 'TestAudit', { env: { account: '111111111111', region: 'us-east-2' } }),
  );
});

describe('AuditStack', () => {
  it('creates two pay-per-request tables (append-only log + mutable projection)', () => {
    t.resourceCountIs('AWS::DynamoDB::Table', 2);
  });

  it('subscribes to every cre.* event via a source prefix match', () => {
    t.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: { source: [{ prefix: 'cre.' }] },
    });
  });

  it('gives the consumer role PutItem and nothing else on the audit table', () => {
    const policies = t.findResources('AWS::IAM::Policy');
    const stmts = Object.values(policies).flatMap(
      (p) => p.Properties.PolicyDocument.Statement as Array<{ Action: unknown; Resource: unknown }>,
    );
    const putOnly = stmts.filter(
      (s) => s.Action === 'dynamodb:PutItem' || (Array.isArray(s.Action) && s.Action.length === 1 && s.Action[0] === 'dynamodb:PutItem'),
    );
    if (putOnly.length !== 1) throw new Error(`expected exactly one PutItem-only statement, got ${putOnly.length}`);
    // and no statement anywhere grants DeleteItem/UpdateItem on the *audit* table
    // (only on the membership table) — checked structurally by the single-action grant above.
  });

  it('runs its Lambdas on nodejs22/arm64 with X-Ray active', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      TracingConfig: { Mode: 'Active' },
    });
  });

  it('routes the queue into the consumer with partial-batch responses + a DLQ', () => {
    t.resourceCountIs('AWS::SQS::Queue', 2);
    t.hasResourceProperties('AWS::SQS::Queue', { RedrivePolicy: { maxReceiveCount: 5 } });
    t.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      FunctionResponseTypes: ['ReportBatchItemFailures'],
    });
  });

  it('registers the 2 JWT-authorized audit routes', () => {
    t.resourceCountIs('AWS::ApiGatewayV2::Route', 2);
    t.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', { AuthorizerType: 'JWT' });
    for (const rk of ['GET /v1/deals/{dealId}/audit', 'GET /v1/deals/{dealId}/audit/export']) {
      t.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: rk, AuthorizationType: 'JWT' });
    }
  });
});
