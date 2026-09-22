/**
 * GitHub route tests.
 *
 * Everything GitHub-shaped is faked at the fetch boundary: no test here may
 * touch api.github.com, because the point is the service's behavior — token
 * resolution order, the fine-grained-PAT fallback, and the export flow — not
 * the provider's. The unhappy paths are the interesting ones: a rejected
 * token must report "not connected" rather than "not configured", and a path
 * that climbs out of the repo must never reach the API.
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { createGitHubRoutes } from './github.js';
import type { SecretsStore } from '../settings.js';

interface Canned {
  ok: boolean;
  status: number;
  body: unknown;
}

const TOKEN = 'github_pat_test-token';

function fakeFetch(routes: Record<string, Canned>, calls: string[]) {
  return (async (url: unknown, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${String(url)}`);
    const canned = routes[`${method} ${String(url)}`] ?? { ok: false, status: 404, body: {} };
    return {
      ok: canned.ok,
      status: canned.status,
      json: async () => canned.body,
      text: async () => (typeof canned.body === 'string' ? canned.body : JSON.stringify(canned.body)),
    };
  }) as unknown as typeof fetch;
}

function fakeSecrets(token: string): Pick<SecretsStore, 'get'> {
  return { get: (name: 'github_pat') => (name === 'github_pat' ? token : '') };
}

let base: string;
let close: () => Promise<void>;
let routes: Record<string, Canned>;
let calls: string[];
let storedToken: string;

function userOk(login = 'octocat'): void {
  routes[`GET https://api.github.com/user`] = { ok: true, status: 200, body: { login } };
}

before(async () => {
  const app = express();
  app.use(express.json());
  routes = {};
  calls = [];
  app.use(
    '/api',
    (req, res, next) => {
      // Rebuilt per request so tests can change the canned API mid-suite.
      const router = createGitHubRoutes({
        secrets: fakeSecrets(storedToken),
        fetchImpl: fakeFetch(routes, calls),
      });
      router(req, res, next);
    },
  );
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  storedToken = '';
});

after(async () => {
  await close();
});

describe('GET /api/github/status', () => {
  test('no token anywhere reports disconnected without calling GitHub', async () => {
    storedToken = '';
    routes = {};
    calls = [];
    const res = await fetch(`${base}/api/github/status`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.connected, false);
    assert.equal(body.hasToken, false);
    assert.equal(body.username, null);
    assert.deepEqual(calls, [], 'no provider call without a token');
  });

  test('a valid stored token reports connected with the provider user', async () => {
    storedToken = TOKEN;
    routes = {};
    calls = [];
    userOk();
    const res = await fetch(`${base}/api/github/status`);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.connected, true);
    assert.equal(body.hasToken, true);
    assert.equal(body.username, 'octocat');
    assert.equal(body.isServerToken, true);
    assert.equal(body.tokenType, 'fine-grained');
    assert.equal(JSON.stringify(body).includes(TOKEN), false, 'the token is never echoed');
  });

  test('a rejected token reports connected:false but hasToken:true', async () => {
    storedToken = 'ghp_bad';
    routes = {};
    routes[`GET https://api.github.com/user`] = { ok: false, status: 401, body: { message: 'Bad credentials' } };
    const res = await fetch(`${base}/api/github/status`);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.connected, false);
    assert.equal(body.hasToken, true);
    assert.equal(body.username, null);
  });

  test('a fine-grained PAT that cannot read /user falls back to the repos call', async () => {
    storedToken = TOKEN;
    routes = {};
    routes[`GET https://api.github.com/user`] = { ok: false, status: 403, body: { message: 'Resource not accessible' } };
    routes[`GET https://api.github.com/user/repos?per_page=1&sort=updated`] = {
      ok: true,
      status: 200,
      body: [{ owner: { login: 'finegrain-user' } }],
    };
    const res = await fetch(`${base}/api/github/status`);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.connected, true);
    assert.equal(body.username, 'finegrain-user');
  });

  test('a per-request token overrides the stored one', async () => {
    storedToken = TOKEN;
    routes = {};
    userOk('header-user');
    const res = await fetch(`${base}/api/github/status`, {
      headers: { 'x-github-token': 'ghp_per-request' },
    });
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.connected, true);
    assert.equal(body.username, 'header-user');
    assert.equal(body.isServerToken, false);
    assert.equal(body.tokenType, 'classic');
  });
});

describe('GET /api/github/repos', () => {
  test('refuses without a token', async () => {
    storedToken = '';
    const res = await fetch(`${base}/api/github/repos`);
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'github_token_required');
  });

  test('returns the mapped repo list', async () => {
    storedToken = TOKEN;
    routes = {};
    routes[`GET https://api.github.com/user/repos?sort=updated&per_page=30`] = {
      ok: true,
      status: 200,
      body: [
        {
          name: 'demo',
          full_name: 'octocat/demo',
          html_url: 'https://github.com/octocat/demo',
          private: false,
          description: 'a demo',
          updated_at: '2026-09-22T00:00:00Z',
          extra: 'dropped',
        },
      ],
    };
    const res = await fetch(`${base}/api/github/repos`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { repos: Array<Record<string, unknown>> };
    assert.equal(body.repos.length, 1);
    assert.equal(body.repos[0].fullName, 'octocat/demo');
    assert.equal(body.repos[0].url, 'https://github.com/octocat/demo');
    assert.equal('extra' in body.repos[0], false);
  });

  test('passes a provider rejection through with its status', async () => {
    storedToken = TOKEN;
    routes = {};
    routes[`GET https://api.github.com/user/repos?sort=updated&per_page=30`] = {
      ok: false,
      status: 403,
      body: { message: 'rate limited' },
    };
    const res = await fetch(`${base}/api/github/repos`);
    assert.equal(res.status, 403);
  });
});

describe('POST /api/github/export-repo', () => {
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/github/export-repo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  test('refuses without a token', async () => {
    storedToken = '';
    const res = await post({ repoName: 'x', files: [{ path: 'a.txt', content: 'a' }] });
    assert.equal(res.status, 401);
  });

  test('requires a repo name and files', async () => {
    storedToken = TOKEN;
    routes = {};
    userOk();
    assert.equal((await post({ files: [{ path: 'a.txt', content: 'a' }] })).status, 400);
    assert.equal((await post({ repoName: 'x' })).status, 400);
    assert.equal((await post({ repoName: 'x', files: [] })).status, 400);
  });

  test('refuses paths that escape the repo', async () => {
    storedToken = TOKEN;
    routes = {};
    userOk();
    for (const bad of ['../evil.txt', '/abs.txt', 'a/../../b.txt']) {
      const res = await post({ repoName: 'x', files: [{ path: bad, content: 'x' }] });
      assert.equal(res.status, 400, bad);
    }
  });

  test('creates the repo and pushes each file, looking up SHAs first', async () => {
    storedToken = TOKEN;
    routes = {};
    calls = [];
    userOk();
    routes[`POST https://api.github.com/user/repos`] = {
      ok: true,
      status: 201,
      body: { html_url: 'https://github.com/octocat/created' },
    };
    routes[`GET https://api.github.com/repos/octocat/created/contents/README.md`] = {
      ok: false,
      status: 404,
      body: { message: 'Not Found' },
    };
    routes[`PUT https://api.github.com/repos/octocat/created/contents/README.md`] = {
      ok: true,
      status: 201,
      body: {},
    };
    const res = await post({
      repoName: 'created',
      files: [{ path: 'README.md', content: '# hi' }],
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.repoUrl, 'https://github.com/octocat/created');
    assert.equal(body.pushedFiles, 1);
    assert.deepEqual(body.failedFiles, []);
    assert.ok(calls.some((c) => c.startsWith('GET https://api.github.com/repos/octocat/created/contents/')));
    assert.ok(calls.some((c) => c.startsWith('PUT https://api.github.com/repos/octocat/created/contents/')));
  });

  test('a 422 on create falls back to pushing into the existing repo', async () => {
    storedToken = TOKEN;
    routes = {};
    userOk();
    routes[`POST https://api.github.com/user/repos`] = {
      ok: false,
      status: 422,
      body: { message: 'already exists' },
    };
    routes[`GET https://api.github.com/repos/octocat/existing/contents/a.txt`] = {
      ok: false,
      status: 404,
      body: {},
    };
    routes[`PUT https://api.github.com/repos/octocat/existing/contents/a.txt`] = {
      ok: true,
      status: 200,
      body: {},
    };
    const res = await post({ repoName: 'existing', files: [{ path: 'a.txt', content: 'a' }] });
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.repoUrl, 'https://github.com/octocat/existing');
    assert.equal(body.pushedFiles, 1);
  });

  test('a rejected token fails closed before any repo call', async () => {
    storedToken = 'ghp_bad';
    routes = {};
    calls = [];
    routes[`GET https://api.github.com/user`] = { ok: false, status: 401, body: {} };
    const res = await post({ repoName: 'x', files: [{ path: 'a.txt', content: 'a' }] });
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'github_auth_failed');
    assert.ok(calls.every((c) => !c.includes('/user/repos') || c.includes('per_page=1')));
  });
});
