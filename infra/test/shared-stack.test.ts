import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { SharedStack } from '../lib/shared-stack.js';

describe('SharedStack', () => {
  it('synthesizes to a valid CloudFormation template', () => {
    const app = new App();
    const stack = new SharedStack(app, 'TestShared', {
      env: { account: '111111111111', region: 'us-east-2' },
    });

    // Module 1: no resources yet — just prove synthesis works end to end.
    const template = Template.fromStack(stack);
    const json = template.toJSON() as Record<string, unknown>;
    expect(typeof json).toBe('object');
    expect(stack.templateOptions.description).toContain('shared infrastructure');
  });
});
