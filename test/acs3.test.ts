import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canonicalQuery, percentEncode, signRequest } from '../server/acs3.ts'

test('matches the worked example in the Alibaba Cloud V3 signature documentation', () => {
  const signed = signRequest({
    method: 'POST',
    host: 'ecs.cn-shanghai.aliyuncs.com',
    action: 'RunInstances',
    version: '2014-05-26',
    query: { ImageId: 'win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd', RegionId: 'cn-shanghai' },
    body: '',
    credentials: { accessKeyId: 'YourAccessKeyId', accessKeySecret: 'YourAccessKeySecret' },
    date: '2023-10-26T10:22:32Z',
    nonce: '3156853299f313e23d1673dc12e1703d',
  })
  assert.equal(
    signed.headers.Authorization,
    'ACS3-HMAC-SHA256 Credential=YourAccessKeyId,SignedHeaders=host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version,Signature=06563a9e1b43f5dfe96b81484da74bceab24a1d853912eee15083a6f0f3283c0',
  )
})

test('percent-encodes the characters encodeURIComponent leaves alone', () => {
  assert.equal(percentEncode("a b*c'(d)!~"), 'a%20b%2Ac%27%28d%29%21~')
  assert.equal(percentEncode('中'), '%E4%B8%AD')
})

test('sorts the canonical query by encoded key', () => {
  assert.equal(canonicalQuery({ b: '2', a: '1', 'a b': '3' }), 'a=1&a%20b=3&b=2')
})

test('signs the security token header when STS credentials are used', () => {
  const signed = signRequest({
    method: 'POST',
    host: 'example.com',
    action: 'A',
    version: 'v',
    query: {},
    body: '',
    credentials: { accessKeyId: 'id', accessKeySecret: 'secret', securityToken: 'token' },
  })
  assert.equal(signed.headers['x-acs-security-token'], 'token')
  assert.match(signed.headers.Authorization ?? '', /SignedHeaders=[^,]*x-acs-security-token/)
})
