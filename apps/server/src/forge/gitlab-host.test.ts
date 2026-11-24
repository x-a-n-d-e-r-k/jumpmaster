import { describe, expect, test } from 'vitest';
import { gitlabPushHost } from './gitlab-host.js';

describe('gitlabPushHost (issue #820)', () => {
  const allow = ['gitlab.example.com'];

  test('a baseUrl that does not parse', () => {
    expect(gitlabPushHost('not a url', allow)).toEqual({
      why: 'its gitlab.baseUrl is not a URL',
    });
  });

  test('a port other than 443', () => {
    expect(gitlabPushHost('https://gitlab.example.com:8443', allow)).toEqual({
      why: 'the egress proxy allows port 443 only, and its GitLab host is on port 8443',
    });
    expect(gitlabPushHost('http://gitlab.example.com', allow)).toEqual({
      why: 'the egress proxy allows port 443 only, and its GitLab host is on port 80',
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
    });
    expect(gitlabPushHost('https://gitlab.example.com', ['*.example.com'])).toEqual({
      host: 'gitlab.example.com',
    });
  });
});
