import { handleApi } from '../server.js';

/*
 * Sites 云函数入口适配层。
 * Sites 的函数运行时数据面接口没有公开文档，所以这里只按常见事件形状容错取值，
 * 真实形状要用 cloud/sites/probe.mjs 与 qoder sites operations 的输出核对后再收紧。
 */
const pick = (obj, keys) => {
  for (const k of keys) {
    const v = obj && obj[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
};

const lower = (h) => {
  const out = {};
  Object.keys(h || {}).forEach((k) => { out[String(k).toLowerCase()] = h[k]; });
  return out;
};

const pathOf = (e) => {
  const raw = pick(e, ['path', 'rawPath', 'pathname', 'url']) || pick(e.request, ['url', 'path']) || '/';
  return String(raw).split('?')[0];
};

const bodyOf = (e) => {
  const raw = pick(e, ['body']) ?? pick(e.request, ['body']) ?? pick(e, ['payload']);
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') return JSON.stringify(raw);
  if (e.isBase64Encoded) {
    try {
      return Buffer.from(raw, 'base64').toString('utf8');
    } catch (err) {
      return raw;
    }
  }
  return raw;
};

const ipOf = (e) => {
  const h = lower(pick(e, ['headers']) || pick(e.request, ['headers']));
  const fwd = h['x-forwarded-for'] || h['x-real-ip'] || h['cf-connecting-ip'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return pick(e.requestContext, ['sourceIp', 'ip']) || pick(e, ['sourceIp']) || 'sites';
};

export async function handler(event, rc, ctx) {
  const result = await handleApi(pathOf(event), bodyOf(event), { ip: ipOf(event) });
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  const origin = process.env.NZZH_ALLOW_ORIGIN || '';
  if (origin) headers['access-control-allow-origin'] = origin;
  return { statusCode: result.status, headers: { ...headers, ...((rc && rc.headers) || {}) }, body: JSON.stringify(result.json) };
}

export default handler;
