import { describe, expect, test } from 'vitest';
import { gitlabPushHost } from './gitlab-host.js';

describe('gitlabPushHost (issue #820)', () => {
  const allow = ['gitlab.example.com'];

  test('a baseUrl that does not parse', () => {
    expect(gitlabPushHost('not a url', allow)).toEqual({
      why: 'its gitlab.baseUrl is not a URL',
    });
  });

  test('any port from 1 to 65535 in an https baseUrl, with its port (#915)', () => {
    expect(gitlabPushHost('https://gitlab.example.com:8443', allow)).toEqual({
      host: 'gitlab.example.com',
      port: 8443,
    });
    expect(gitlabPushHost('https://gitlab.example.com:443', allow)).toEqual({
      host: 'gitlab.example.com',
      port: 443,
    });
    expect(gitlabPushHost('https://gitlab.example.com', allow)).toEqual({
      host: 'gitlab.example.com',
      port: 443,
    });
    expect(gitlabPushHost('https://gitlab.example.com:1', allow)).toEqual({
      host: 'gitlab.example.com',
      port: 1,
    });
    expect(gitlabPushHost('https://gitlab.example.com:65535', allow)).toEqual({
      host: 'gitlab.example.com',
      port: 65535,
    });
  });

  test('a baseUrl that is not https, or on port 0', () => {
    expect(gitlabPushHost('http://gitlab.example.com', allow)).toEqual({
      why: 'its gitlab.baseUrl is not https',
    });
    expect(gitlabPushHost('https://gitlab.example.com:0', allow)).toEqual({
      why: 'its GitLab host is on port 0',
    });
  });

  test('a refusal stays a refusal on another port', () => {
    expect(gitlabPushHost('https://10.0.0.5:8443', ['10.0.0.5'])).toEqual({
      why: 'its GitLab host 10.0.0.5 is not a DNS name',
    });
    expect(gitlabPushHost('https://gitlab.example.com:8443', ['github.com'])).toEqual({
      why: "its GitLab host is not allowed: add gitlab.example.com to the zone's egress.allow",
    });
  });

  test('a host that is not a DNS name', () => {
    expect(gitlabPushHost('https://10.0.0.5', ['10.0.0.5'])).toEqual({
      why: 'its GitLab host 10.0.0.5 is not a DNS name',
    });
  });

  test('a host the allow list does not allow', () => {
    expect(gitlabPushHost('https://gitlab.example.com', ['github.com'])).toEqual({
      why: "its GitLab host is not allowed: add gitlab.example.com to the zone's egress.allow",
    });
  });

  test('the canonical host, by exact name or a wildcard', () => {
    expect(gitlabPushHost('https://GitLab.Example.com:443/group/project', allow)).toEqual({
      host: 'gitlab.example.com',
      port: 443,
    });
    expect(gitlabPushHost('https://gitlab.example.com', ['*.example.com'])).toEqual({
      host: 'gitlab.example.com',
      port: 443,
    });
  });
});
