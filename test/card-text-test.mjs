// 卡片消息解析回归（json / xml 段展开 + message.card-text 能力优先）。
//
// 覆盖：
//   1. json 卡片：detail_1 / news / meta.* 三种形状；
//   2. xml 卡片：title/summary/url/source + XML 实体解码；
//   3. 坏 JSON / 坏 XML → 回落原占位符（[卡片消息] / [xml]），绝不抛异常；
//   4. 字段截断（每项 ≤120 字）；
//   5. 无提供者时内置解析生效；有 message.card-text 提供者时先用它，
//      提供者返回非法/抛错时回落内置（fail-open）。
//
// 运行：node test/card-text-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 数据目录隔离必须在 import src 之前
process.env.QQ_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-card-text-'));

const { cardTextFromJson, cardTextFromXml, cardTextBuiltin, cardTextFromSegment, segmentsToText } =
  await import('../src/onebot.js');
const { skillManager } = await import('../src/skills/manager.js');
const { normalizeManifest } = await import('../src/skills/manifest.js');

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`  ✗ ${name}\n      ${e.message}`);
  }
}

/** 注册一个提供 message.card-text 的假插件（只能有一个提供者，用前注册、用后注销）。 */
function addCardProvider(id, fn) {
  const { manifest } = normalizeManifest({ id, name: id, capabilities: ['message.card-text'], enabledByDefault: true });
  const r = skillManager.register({
    manifest, source: 'test', dir: path.join(os.tmpdir(), id), api: null, toolIds: [],
    available: null, availableReason: '', activate: null, deactivate: null,
    dispose: () => {}, hooks: {}, providers: { 'message.card-text': fn }, promptSections: null
  });
  assert.ok(r.ok, `注册假卡片插件失败：${r.error || ''}`);
}
const removeCardProvider = (id) => { try { skillManager.unregister(id); } catch { /* ignore */ } };

// ── 1. JSON 卡片 ─────────────────────────────────────────────────────────
await check('json detail_1 形状：标题/描述/链接/来源全部展开', () => {
  const payload = {
    app: 'com.tencent.structmsg',
    meta: {
      detail_1: {
        title: 'B 站视频标题',
        desc: '这里有 B 站小程序的卡片预览描述',
        preview: 'https://img.example/cover.jpg',
        qqdocurl: 'https://b23.tv/abcd',
        source: '哔哩哔哩'
      }
    }
  };
  assert.equal(cardTextFromJson(JSON.stringify(payload)), '[卡片: B 站视频标题｜这里有 B 站小程序的卡片预览描述｜https://b23.tv/abcd｜哔哩哔哩]');
});

await check('json news 形状（公众号图文）：url/tag 字段也能展开', () => {
  const payload = {
    app: 'com.tencent.news',
    meta: { news: { title: '公众号文章标题', desc: '摘要内容', url: 'https://mp.weixin.qq.com/s/xxx', tag: '公众号' } }
  };
  assert.equal(cardTextFromJson(JSON.stringify(payload)), '[卡片: 公众号文章标题｜摘要内容｜https://mp.weixin.qq.com/s/xxx｜公众号]');
});

await check('json meta.* 任意形状：字段名一致时同样能读；只有 preview 时当描述', () => {
  const payload = { meta: { custom_key: { title: '自定义卡片', preview: '预览文字', jumpUrl: 'https://x.example/y' } } };
  assert.equal(cardTextFromJson(JSON.stringify(payload)), '[卡片: 自定义卡片｜预览文字｜https://x.example/y]');
});

await check('坏 JSON / 空载荷 / 未知结构 → 返回 null（调用方回落 [卡片消息]）', () => {
  assert.equal(cardTextFromJson('{oops'), null);
  assert.equal(cardTextFromJson(''), null);
  assert.equal(cardTextFromJson('{"meta":{}}'), null);
  assert.equal(cardTextFromJson(null), null);
  assert.equal(cardTextFromJson({ a: 1 }), null);
});

// ── 2. XML 卡片 ──────────────────────────────────────────────────────────
await check('xml 卡片：title/summary/url/source + 实体解码', () => {
  const xml = '<msg serviceID="1"><item><title>标题 &amp; 实体</title><summary>一段摘要</summary>'
    + '<url>https://x.example/y?a=1&amp;b=2</url><source name="来源应用"/></item></msg>';
  assert.equal(cardTextFromXml(xml), '[卡片: 标题 & 实体｜一段摘要｜https://x.example/y?a=1&b=2｜来源应用]');
});

await check('坏 XML / 无字段 → 返回 null（调用方回落 [xml]）', () => {
  assert.equal(cardTextFromXml('<msg'), null);
  assert.equal(cardTextFromXml(''), null);
  assert.equal(cardTextFromXml('<msg><item></item></msg>'), null);
});

// ── 3. 字段截断 ──────────────────────────────────────────────────────────
await check('字段单项 ≤120 字（超长截断加省略号，不会把整篇文章塞进提示词）', () => {
  const long = '长'.repeat(300);
  const text = cardTextFromJson(JSON.stringify({ meta: { news: { title: long, desc: long } } }));
  assert.ok(text.startsWith('[卡片: '), '仍是卡片行');
  assert.ok(text.endsWith('…]'), `超长字段应截断，实际尾部：${text.slice(-5)}`);
  const title = text.slice(text.indexOf('[卡片: ') + 5).split('｜')[0];
  assert.equal(title.length, 121, `标题应截到 120 字 + 省略号，实际 ${title.length}`);
});

// ── 4. segmentsToText 集成：json / xml 段 ────────────────────────────────
await check('segmentsToText：json 卡片段展开成 [卡片: …]，不再只有 [卡片消息]', async () => {
  const payload = JSON.stringify({ meta: { news: { title: '卡片标题', desc: '卡片描述', url: 'https://x.example' } } });
  const text = await segmentsToText([{ type: 'json', data: { data: payload } }]);
  assert.equal(text, '[卡片: 卡片标题｜卡片描述｜https://x.example]');
});

await check('segmentsToText：坏 json 段回落 [卡片消息]；xml 段展开；坏 xml 段回落 [xml]', async () => {
  assert.equal(await segmentsToText([{ type: 'json', data: { data: '{bad' } }]), '[卡片消息]');
  const xml = '<msg><item><title>XML 标题</title><summary>XML 摘要</summary></item></msg>';
  assert.equal(await segmentsToText([{ type: 'xml', data: { data: xml } }]), '[卡片: XML 标题｜XML 摘要]');
  assert.equal(await segmentsToText([{ type: 'xml', data: { data: '<msg' } }]), '[xml]');
});

await check('segmentsToText：卡片与普通文本混排时顺序不变', async () => {
  const payload = JSON.stringify({ meta: { news: { title: '标题甲' } } });
  const text = await segmentsToText([
    { type: 'text', data: { text: '看这个 ' } },
    { type: 'json', data: { data: payload } },
    { type: 'text', data: { text: ' 好康的' } }
  ]);
  assert.equal(text, '看这个 [卡片: 标题甲] 好康的');
});

// ── 5. message.card-text 能力：优先 / 回落 ───────────────────────────────
await check('无提供者时 cardTextFromSegment 用内置解析', async () => {
  const seg = { type: 'json', data: { data: JSON.stringify({ meta: { news: { title: '内置标题' } } }) } };
  assert.equal(await cardTextFromSegment(seg), '[卡片: 内置标题]');
});

await check('有提供者时先用它；返回非法/抛错时回落内置（fail-open）', async () => {
  const seg = { type: 'json', data: { data: JSON.stringify({ meta: { news: { title: '内置标题' } } }) } };

  addCardProvider('card-ok', ({ segment }) => `[卡片: 插件解析 ${segment.type}]`);
  try {
    assert.equal(await cardTextFromSegment(seg), '[卡片: 插件解析 json]');
  } finally { removeCardProvider('card-ok'); }

  addCardProvider('card-bad', () => ({ not: 'a string' }));
  try {
    assert.equal(await cardTextFromSegment(seg), '[卡片: 内置标题]', '返回非法应回落内置');
  } finally { removeCardProvider('card-bad'); }

  addCardProvider('card-throw', () => { throw new Error('假插件故意抛错'); });
  try {
    assert.equal(await cardTextFromSegment(seg), '[卡片: 内置标题]', '抛错应回落内置');
  } finally { removeCardProvider('card-throw'); }
});

await check('提供者返回 null → 回落内置；返回空白字符串同样回落', async () => {
  const seg = { type: 'xml', data: { data: '<msg><item><title>内置 XML</title></item></msg>' } };
  addCardProvider('card-null', () => null);
  try {
    assert.equal(await cardTextFromSegment(seg), '[卡片: 内置 XML]');
  } finally { removeCardProvider('card-null'); }
});

// ── 6. 内置解析不抛异常（防御性：任何形状的段都不能打断入库）───────────
await check('cardTextBuiltin 对各种畸形段都不抛异常', () => {
  for (const seg of [null, undefined, {}, { type: 'json' }, { type: 'json', data: null }, { type: 'xml', data: { data: 42 } }]) {
    assert.doesNotThrow(() => cardTextBuiltin(seg), `畸形段不应抛异常：${JSON.stringify(seg)}`);
  }
});

if (fail === 0) {
  console.log(`\n全部通过 —— 通过 ${pass} / 失败 0`);
  process.exit(0);
}
console.log(`\n失败 ${fail}`);
process.exit(1);
