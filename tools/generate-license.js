#!/usr/bin/env node
const fs = require('node:fs');
const crypto = require('node:crypto');

const PRODUCT_ID = 'loveyu.loveyu-database-workbench';
const LICENSE_PREFIX = 'DBW_PRO_V1';

function getArg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

function normalizeMachineCode(machine) {
  return String(machine || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
}

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

const machine = normalizeMachineCode(getArg('machine'));
if (!machine) {
  console.error('缺少参数：--machine <机器码>');
  process.exit(1);
}
if (!/^[0-9A-F]{16}$/.test(machine)) {
  console.error(`机器码格式不正确：${machine || '(空)'}。请使用插件复制出来的 16 位机器码。`);
  process.exit(1);
}

const privateKeyPath = getArg('private-key', '.license-private/private.pem');
const privateKey = fs.readFileSync(privateKeyPath, 'utf8');
const features = String(getArg('features', 'ai,logs,schemaCompare'))
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

const payload = {
  schema: 1,
  product: PRODUCT_ID,
  licenseId: getArg('license-id', `LIC-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Date.now().toString(36).toUpperCase()}`),
  email: getArg('email', ''),
  machine,
  plan: 'pro',
  kind: 'lifetime',
  features,
  issuedAt: new Date().toISOString(),
  maxMajorVersion: Number(getArg('max-major-version', '1')),
};

const payloadPart = base64url(JSON.stringify(payload));
const signature = crypto.sign(null, Buffer.from(payloadPart, 'utf8'), privateKey);
const license = `${LICENSE_PREFIX}.${payloadPart}.${base64url(signature)}`;

const publicKeyPath = getArg('public-key', '.license-private/public.pem');
if (fs.existsSync(publicKeyPath)) {
  const publicKey = fs.readFileSync(publicKeyPath, 'utf8');
  const verified = crypto.verify(null, Buffer.from(payloadPart, 'utf8'), publicKey, signature);
  if (!verified) {
    console.error(`许可证生成失败：${privateKeyPath} 与 ${publicKeyPath} 不匹配。`);
    process.exit(1);
  }
}

console.log('\n许可证：\n');
console.log(license);
console.log('\n许可证信息：\n');
console.log(JSON.stringify(payload, null, 2));
