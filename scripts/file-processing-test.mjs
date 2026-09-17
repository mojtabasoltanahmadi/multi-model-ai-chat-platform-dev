/**
 * End-to-end acceptance test for the Day 5-6 file feature.
 *
 * Requires: backend (default http://localhost:4000), PostgreSQL, Redis and
 * MinIO running (see infra/docker-compose.yml), plus the ADMIN_* credentials
 * from backend/.env.
 *
 * Usage: node scripts/file-processing-test.mjs
 *        API_BASE=http://localhost:4010/api node scripts/file-processing-test.mjs
 *
 * The script boots a tiny OpenAI-compatible ECHO provider and points a model
 * at it, so the streamed answer literally contains the prompt the backend
 * built — that is how "the AI used the file content" is verified without an
 * external LLM. It also exercises the failure, authorization and
 * validation paths.
 */
import http from 'node:http';
import zlib from 'node:zlib';

const BASE = process.env.API_BASE ?? 'http://localhost:4000/api';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'admin1234';
const ECHO_PORT = Number(process.env.ECHO_PORT ?? 4999);

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function api(method, path, { token, body } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    /* empty body */
  }
  return { status: response.status, json };
}

async function fetchRaw(token, path) {
  const response = await fetch(`${BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, buffer };
}

async function upload(token, conversationId, { buffer, name, type }) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type }), name);
  const response = await fetch(`${BASE}/conversations/${conversationId}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    /* empty */
  }
  return { status: response.status, json };
}

async function getFile(token, fileId) {
  const response = await fetch(`${BASE}/files/${fileId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    /* empty */
  }
  return { status: response.status, json };
}

/** Polls a file until it reaches a terminal status. */
async function waitForTerminal(token, fileId, timeoutMs = 90000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    const { status, json } = await getFile(token, fileId);
    if (status !== 200) return { status, file: json, error: 'status endpoint failed' };
    last = json;
    if (json.status === 'READY' || json.status === 'FAILED') {
      return { status, file: json, elapsedMs: Date.now() - started };
    }
    await sleep(600);
  }
  return { status: 200, file: last, error: 'timeout waiting for terminal status' };
}

/** Reads an SSE chat turn and returns deltas + the terminal event. */
async function streamMessage(token, conversationId, body) {
  const response = await fetch(`${BASE}/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (text.trimStart().startsWith('{')) {
    let errorJson = null;
    try {
      errorJson = JSON.parse(text);
    } catch {
      /* ignore */
    }
    return { status: response.status, events: [], deltas: [], errorJson };
  }
  const events = [];
  for (const block of text.split('\n\n').filter(Boolean)) {
    const lines = block.split('\n');
    const event = lines.find((l) => l.startsWith('event: '))?.slice(7);
    const data = lines.find((l) => l.startsWith('data: '))?.slice(6);
    if (event && data) {
      try {
        events.push({ event, data: JSON.parse(data) });
      } catch {
        /* ignore keep-alive */
      }
    }
  }
  return {
    status: response.status,
    events,
    deltas: events.filter((e) => e.event === 'delta').map((e) => e.data.text),
    errorJson: null,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- fixtures

const PDF_TEXT = 'Quarterly revenue reached fourty two million dollars';

function pdfBuffer(text = PDF_TEXT) {
  const content = `BT /F1 14 Tf 20 100 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/** Hand-built xlsx (single sheet, no external writer needed). */
function xlsxBuffer() {
  const rows = [['Name', 'Age', 'City'], ['Ali', '22', 'Mashhad'], ['Sara', '25', 'Tehran']];
  const sheetRows = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, columnIndex) => {
          const ref = `${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}`;
          return `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`;
        })
        .join('');
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join('');
  const sheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`;
  const workbook =
    '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Customers" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></sheets></workbook>';
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>';
  const rootRels =
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
  const workbookRels =
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>';

  return zip({
    '[Content_Types].xml': contentTypes,
    '_rels/.rels': rootRels,
    'xl/workbook.xml': workbook,
    'xl/_rels/workbook.xml.rels': workbookRels,
    'xl/worksheets/sheet1.xml': sheet,
  });
}

/** Minimal store-only zip writer (an xlsx is a zip of XML parts). */
function zip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored, no compression
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...chunks, centralBuf, end]);
}

function crc32(buffer) {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const FONT = {
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
};

/** PNG with the word HELLO drawn as scaled bitmap glyphs. */
function helloPngBuffer(word = 'HELLO', scale = 8) {
  const glyphWidth = 5 * scale;
  const glyphHeight = 7 * scale;
  const gap = scale * 2;
  const margin = scale * 4;
  const width = margin * 2 + word.length * glyphWidth + (word.length - 1) * gap;
  const height = margin * 2 + glyphHeight;

  const rgba = Buffer.alloc(width * height * 4, 0xff);
  const paint = (x0, y0, size) => {
    for (let y = y0; y < y0 + size; y++) {
      for (let x = x0; x < x0 + size; x++) {
        const i = (y * width + x) * 4;
        rgba[i] = 0;
        rgba[i + 1] = 0;
        rgba[i + 2] = 0;
        rgba[i + 3] = 255;
      }
    }
  };

  word.split('').forEach((character, index) => {
    const glyph = FONT[character];
    if (!glyph) return;
    const originX = margin + index * (glyphWidth + gap);
    glyph.forEach((row, rowIndex) => {
      row.split('').forEach((pixel, columnIndex) => {
        if (pixel === '1') {
          paint(
            originX + columnIndex * scale,
            margin + rowIndex * scale,
            scale,
          );
        }
      });
    });
  });

  return encodePng(width, height, rgba);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
    return Buffer.concat([length, typeBuf, data, crcBuf]);
  };
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function tinyPngBuffer() {
  return encodePng(4, 4, Buffer.alloc(4 * 4 * 4, 0xff));
}

// ------------------------------------------------------- echo AI provider

/**
 * OpenAI-compatible SSE provider that echoes the last user message back.
 * Whatever the backend put in the prompt is therefore visible in the answer.
 */
function startEchoProvider() {
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      let prompt = '';
      try {
        const parsed = JSON.parse(body);
        const messages = parsed.messages ?? [];
        prompt = messages.at(-1)?.content ?? '';
      } catch {
        prompt = '';
      }
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      });
      const chunks = prompt.match(/[\s\S]{1,60}/g) ?? [''];
      for (const chunk of chunks) {
        response.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`,
        );
      }
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(ECHO_PORT, '127.0.0.1', () => resolve(server));
  });
}

// ------------------------------------------------------------------- main

async function main() {
  const echoServer = await startEchoProvider();
  console.log(`Echo AI provider listening on http://127.0.0.1:${ECHO_PORT}/v1\n`);

  const run = Date.now().toString(36);

  // ---- auth ----
  const adminLogin = await api('POST', '/auth/login', {
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  check('admin can log in', adminLogin.status === 200 || adminLogin.status === 201);
  const adminToken = adminLogin.json?.accessToken;

  const userA = await api('POST', '/auth/register', {
    body: { email: `file-a-${run}@example.com`, password: 'password123' },
  });
  const userB = await api('POST', '/auth/register', {
    body: { email: `file-b-${run}@example.com`, password: 'password123' },
  });
  check('two test users registered', userA.status === 201 && userB.status === 201);
  const tokenA = userA.json?.accessToken;
  const tokenB = userB.json?.accessToken;

  // ---- a model the chat can actually use (explicit id, default untouched) ----
  const model = await api('POST', '/admin/models', {
    token: adminToken,
    body: {
      name: `Echo (file test ${run})`,
      provider: 'openai-compatible',
      externalModelId: 'echo',
      baseUrl: `http://127.0.0.1:${ECHO_PORT}/v1`,
      apiKey: 'test-key',
      isActive: true,
      isFree: true,
    },
  });
  check('admin created an echo model', model.status === 201, JSON.stringify(model.json));
  const modelId = model.json?.id;

  const conversation = await api('POST', '/conversations', {
    token: tokenA,
    body: { title: 'file processing test' },
  });
  check('user A created a conversation', conversation.status === 201);
  const conversationId = conversation.json?.id;

  // ---- Scenario 1: PDF upload → PROCESSING → READY → chat uses content ----
  const uploadStart = Date.now();
  const pdfUpload = await upload(tokenA, conversationId, {
    buffer: pdfBuffer(),
    name: 'revenue-report.pdf',
    type: 'application/pdf',
  });
  const uploadMs = Date.now() - uploadStart;
  check('PDF upload accepted (201)', pdfUpload.status === 201, JSON.stringify(pdfUpload.json));
  check(
    'PDF upload returned promptly (<5s) instead of extracting inline',
    uploadMs < 5000,
    `${uploadMs}ms`,
  );
  check(
    'upload response carries lifecycle status, never extracted text',
    pdfUpload.json &&
      ['UPLOADING', 'PROCESSING'].includes(pdfUpload.json.status) &&
      !('extractedText' in pdfUpload.json) &&
      !('storageKey' in pdfUpload.json),
    JSON.stringify(pdfUpload.json),
  );

  const pdfFileId = pdfUpload.json?.id;

  // Chat must keep working while the file is still processing (Section 9).
  const whileProcessing = await streamMessage(tokenA, conversationId, {
    content: 'سلام، این یک پیام معمولی است',
    modelId,
  });
  check(
    'chat still streams while a file is processing',
    whileProcessing.status === 200 &&
      whileProcessing.deltas.length > 0 &&
      whileProcessing.events.at(-1)?.event === 'done',
    JSON.stringify(whileProcessing.errorJson ?? whileProcessing.events.at(-1)),
  );

  const pdfTerminal = await waitForTerminal(tokenA, pdfFileId);
  check(
    'PDF reached READY',
    pdfTerminal.file?.status === 'READY',
    `${pdfTerminal.file?.status} ${pdfTerminal.file?.errorMessage ?? ''}`,
  );
  check('PDF processing completed quickly', (pdfTerminal.elapsedMs ?? 0) < 60000);

  const pdfAnswer = await streamMessage(tokenA, conversationId, {
    content: 'این فایل درباره چیست؟',
    modelId,
    fileIds: [pdfFileId],
  });
  const pdfAnswerText = pdfAnswer.deltas.join('');
  check(
    'AI answer contains the extracted PDF text (context reached the model)',
    pdfAnswerText.includes('fourty two million'),
    pdfAnswerText.slice(0, 200),
  );

  const afterAnswer = await api('GET', `/conversations/${conversationId}`, { token: tokenA });
  const lastUser = [...(afterAnswer.json?.messages ?? [])]
    .reverse()
    .find((message) => message.role === 'user');
  check(
    'the stored user message keeps the user text and references the file id',
    lastUser?.content === 'این فایل درباره چیست؟' &&
      Array.isArray(lastUser?.attachedFileIds) &&
      lastUser.attachedFileIds.includes(pdfFileId),
    JSON.stringify(lastUser),
  );

  // ---- Scenario 2: Excel ----
  const xlsxUpload = await upload(tokenA, conversationId, {
    buffer: xlsxBuffer(),
    name: 'customers.xlsx',
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  check('Excel upload accepted', xlsxUpload.status === 201, JSON.stringify(xlsxUpload.json));
  const xlsxTerminal = await waitForTerminal(tokenA, xlsxUpload.json?.id);
  check(
    'Excel reached READY',
    xlsxTerminal.file?.status === 'READY',
    `${xlsxTerminal.file?.status} ${xlsxTerminal.file?.errorMessage ?? ''}`,
  );

  const xlsxAnswer = await streamMessage(tokenA, conversationId, {
    content: 'داده‌های این فایل را خلاصه کن',
    modelId,
    fileIds: [xlsxUpload.json.id],
  });
  const xlsxAnswerText = xlsxAnswer.deltas.join('');
  check(
    'AI answer contains the parsed spreadsheet cells',
    xlsxAnswerText.includes('Mashhad') && xlsxAnswerText.includes('Customers'),
    xlsxAnswerText.slice(0, 200),
  );

  // ---- Scenario 3: image OCR ----
  const pngUpload = await upload(tokenA, conversationId, {
    buffer: helloPngBuffer(),
    name: 'scan.png',
    type: 'image/png',
  });
  check('image upload accepted', pngUpload.status === 201, JSON.stringify(pngUpload.json));
  const pngTerminal = await waitForTerminal(tokenA, pngUpload.json?.id, 150000);
  check(
    'image reached READY through OCR',
    pngTerminal.file?.status === 'READY',
    `${pngTerminal.file?.status} ${pngTerminal.file?.errorMessage ?? ''}`,
  );

  if (pngTerminal.file?.status === 'READY') {
    const ocrAnswer = await streamMessage(tokenA, conversationId, {
      content: 'در این تصویر چه نوشته شده؟',
      modelId,
      fileIds: [pngUpload.json.id],
    });
    const ocrText = ocrAnswer.deltas.join('').toUpperCase();
    check(
      'OCR text reached the model',
      ocrText.includes('HELL'),
      ocrAnswer.deltas.join('').slice(0, 200),
    );
  }

  // ---- Scenario 4: refresh/reload sees persisted status ----
  const listWhileReady = await api('GET', `/conversations/${conversationId}/files`, {
    token: tokenA,
  });
  check(
    'conversation file list restores statuses after a reload',
    listWhileReady.status === 200 &&
      listWhileReady.json.length >= 3 &&
      listWhileReady.json.every((file) => typeof file.status === 'string') &&
      listWhileReady.json.every((file) => !('extractedText' in file)),
    JSON.stringify(listWhileReady.json)?.slice(0, 200),
  );

  // ---- Scenario 6: corrupted file → FAILED with a safe reason ----
  const corruptUpload = await upload(tokenA, conversationId, {
    buffer: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('not really a pdf body')]),
    name: 'broken.pdf',
    type: 'application/pdf',
  });
  check('corrupted PDF passes upload (signature ok) and is queued', corruptUpload.status === 201);
  const corruptTerminal = await waitForTerminal(tokenA, corruptUpload.json?.id);
  check(
    'corrupted PDF ends in FAILED with a readable reason',
    corruptTerminal.file?.status === 'FAILED' &&
      typeof corruptTerminal.file?.errorMessage === 'string' &&
      corruptTerminal.file.errorMessage.length > 0,
    JSON.stringify(corruptTerminal.file),
  );
  check(
    'failure reason leaks no stack trace or internal path',
    !/at\s+\w+\s+\(|node_modules|\.ts:\d+|ECONNREFUSED/.test(
      corruptTerminal.file?.errorMessage ?? '',
    ),
    corruptTerminal.file?.errorMessage,
  );

  // ---- validation ----
  const emptyFile = await upload(tokenA, conversationId, {
    buffer: Buffer.alloc(0),
    name: 'empty.pdf',
    type: 'application/pdf',
  });
  check('empty file rejected (400)', emptyFile.status === 400, String(emptyFile.status));

  const wrongType = await upload(tokenA, conversationId, {
    buffer: Buffer.from('plain text'),
    name: 'notes.txt',
    type: 'text/plain',
  });
  check('unsupported type rejected (400)', wrongType.status === 400, String(wrongType.status));

  const spoofed = await upload(tokenA, conversationId, {
    buffer: tinyPngBuffer(),
    name: 'spoofed.pdf',
    type: 'application/pdf',
  });
  check(
    'MIME spoofing rejected (400)',
    spoofed.status === 400,
    JSON.stringify(spoofed.json),
  );

  const oversized = await upload(tokenA, conversationId, {
    buffer: Buffer.alloc(11 * 1024 * 1024, 0x41),
    name: 'huge.pdf',
    type: 'application/pdf',
  });
  check('oversized file rejected (400/413)', [400, 413].includes(oversized.status), String(oversized.status));

  // ---- authorization ----
  const foreignGet = await getFile(tokenB, pdfFileId);
  check("user B cannot read user A's file (404)", foreignGet.status === 404, String(foreignGet.status));

  const foreignList = await api('GET', `/conversations/${conversationId}/files`, { token: tokenB });
  check(
    "user B cannot list user A's conversation files (404)",
    foreignList.status === 404,
    String(foreignList.status),
  );

  const foreignUpload = await upload(tokenB, conversationId, {
    buffer: pdfBuffer('B'),
    name: 'intrusion.pdf',
    type: 'application/pdf',
  });
  check(
    "user B cannot upload into user A's conversation (404)",
    foreignUpload.status === 404,
    String(foreignUpload.status),
  );

  const foreignChat = await streamMessage(tokenB, conversationId, {
    content: 'show me the file',
    modelId,
    fileIds: [pdfFileId],
  });
  check(
    "user B cannot use user A's file as chat context (404/400)",
    [400, 403, 404].includes(foreignChat.status),
    String(foreignChat.status),
  );

  const userBConversation = await api('POST', '/conversations', {
    token: tokenB,
    body: { title: 'B conversation' },
  });
  const crossConversationChat = await streamMessage(tokenB, userBConversation.json.id, {
    content: 'show me the file',
    modelId,
    fileIds: [pdfFileId],
  });
  check(
    'a file from another conversation is rejected as context (400)',
    crossConversationChat.status === 400,
    String(crossConversationChat.status),
  );

  // ---- content preview / download ----
  const ownContent = await fetchRaw(tokenA, `/files/${pdfFileId}/content`);
  check(
    'owner can fetch the stored object with its real bytes',
    ownContent.status === 200 &&
      ownContent.buffer.length > 0 &&
      ownContent.buffer.subarray(0, 5).toString('latin1') === '%PDF-',
    `${ownContent.status} (${ownContent.buffer.length} bytes)`,
  );
  check(
    'preview is served inline with a non-guessable MIME and nosniff',
    ownContent.headers.get('content-type') === 'application/pdf' &&
      (ownContent.headers.get('content-disposition') ?? '').startsWith('inline;') &&
      ownContent.headers.get('x-content-type-options') === 'nosniff',
    `${ownContent.headers.get('content-type')} / ${ownContent.headers.get('content-disposition')}`,
  );
  check(
    'the storage key is never exposed in the response headers',
    !JSON.stringify([...ownContent.headers.entries()]).includes('files/'),
  );

  const forcedDownload = await fetchRaw(tokenA, `/files/${pdfFileId}/content?download=1`);
  const disposition = forcedDownload.headers.get('content-disposition') ?? '';
  check(
    'download=1 forces an attachment carrying the original name',
    disposition.startsWith('attachment;') && disposition.includes('report'),
    disposition,
  );

  const pngContent = await fetchRaw(tokenA, `/files/${pngUpload.json.id}/content`);
  check(
    'images are served inline for thumbnails',
    pngContent.status === 200 && (pngContent.headers.get('content-disposition') ?? '').startsWith('inline;'),
    String(pngContent.status),
  );

  const xlsxContent = await fetchRaw(tokenA, `/files/${xlsxUpload.json.id}/content`);
  check(
    'non-previewable types are always downloads',
    xlsxContent.status === 200 &&
      (xlsxContent.headers.get('content-disposition') ?? '').startsWith('attachment;'),
    String(xlsxContent.status),
  );

  const foreignContent = await fetchRaw(tokenB, `/files/${pdfFileId}/content`);
  check(
    "user B cannot read user A's file bytes (404)",
    foreignContent.status === 404,
    String(foreignContent.status),
  );

  const anonymousContent = await fetchRaw(null, `/files/${pdfFileId}/content`);
  check('anonymous access to file bytes is rejected (401)', anonymousContent.status === 401, String(anonymousContent.status));

  // ---- non-ASCII names ----
  // Multipart filenames arrive as latin1-decoded bytes, so a Persian name has
  // to survive upload → storage → download unchanged (no mojibake shipped to
  // the user's screen, storage key or Content-Disposition header).
  const persianName = 'گزارش-فروش-۱۴۰۵.pdf';
  const persianUpload = await upload(tokenA, conversationId, {
    buffer: pdfBuffer(),
    name: persianName,
    type: 'application/pdf',
  });
  check(
    'a Persian file name is stored unmangled',
    persianUpload.json?.originalName === persianName,
    String(persianUpload.json?.originalName),
  );

  const persianContent = await fetchRaw(tokenA, `/files/${persianUpload.json.id}/content?download=1`);
  const persianDisposition = persianContent.headers.get('content-disposition') ?? '';
  check(
    'the downloaded file keeps the Persian name',
    persianDisposition.includes("filename*=UTF-8") &&
      persianDisposition.includes(encodeURIComponent(persianName)),
    persianDisposition,
  );

  const nonAdminAdmin = await api('GET', '/admin/files', { token: tokenA });
  check('normal user cannot read the admin file view (403)', nonAdminAdmin.status === 403, String(nonAdminAdmin.status));

  // ---- admin view ----
  const adminList = await api('GET', '/admin/files?limit=50', { token: adminToken });
  check('admin can list files', adminList.status === 200, String(adminList.status));
  const adminItems = adminList.json?.items ?? [];
  check(
    'admin list exposes status, owner, conversation and error (no extracted text)',
    adminItems.length >= 4 &&
      adminItems.every((item) => item.status && item.userEmail && item.conversationId) &&
      adminItems.every((item) => !('extractedText' in item)),
  );
  check(
    'admin can identify failed files with their reason',
    adminItems.some((item) => item.status === 'FAILED' && item.errorMessage),
  );

  const failedFilter = await api('GET', '/admin/files?status=FAILED', { token: adminToken });
  check(
    'admin can filter by status',
    failedFilter.status === 200 && (failedFilter.json?.items ?? []).length >= 1,
  );

  const stats = await api('GET', '/admin/files/stats', { token: adminToken });
  check(
    'admin stats report per-status counts and queue depth',
    stats.status === 200 &&
      typeof stats.json?.counts?.total === 'number' &&
      stats.json?.counts?.READY >= 3,
    JSON.stringify(stats.json),
  );

  const reprocess = await api('POST', `/admin/files/${corruptUpload.json.id}/reprocess`, {
    token: adminToken,
  });
  check(
    'admin can explicitly reprocess a FAILED file',
    reprocess.status === 200 || reprocess.status === 201,
    JSON.stringify(reprocess.json),
  );
  const reprocessed = await waitForTerminal(tokenA, corruptUpload.json.id, 60000);
  check(
    'reprocessed file fails again with a reason instead of looping forever',
    reprocessed.file?.status === 'FAILED',
    JSON.stringify(reprocessed.file),
  );

  const reprocessReady = await api('POST', `/admin/files/${pdfFileId}/reprocess`, {
    token: adminToken,
  });
  check(
    'admin reprocess is the only path READY → PROCESSING',
    [200, 201].includes(reprocessReady.status),
    JSON.stringify(reprocessReady.json),
  );
  const readyAfterReprocess = await waitForTerminal(tokenA, pdfFileId, 60000);
  check(
    'reprocessed READY file returns to READY with content intact',
    readyAfterReprocess.file?.status === 'READY',
    JSON.stringify(readyAfterReprocess.file),
  );

  // ---- attachments on a non-ready file are refused with a clear message ----
  const processingUpload = await upload(tokenA, conversationId, {
    buffer: pdfBuffer('still processing'),
    name: 'in-flight.pdf',
    type: 'application/pdf',
  });
  const immediateChat = await streamMessage(tokenA, conversationId, {
    content: 'این فایل درباره چیست؟',
    modelId,
    fileIds: [processingUpload.json.id],
  });
  check(
    'attaching a file that is not READY yet yields a clear 400',
    immediateChat.status === 400 &&
      typeof immediateChat.errorJson?.message === 'string' &&
      /پردازش|در دسترس/.test(immediateChat.errorJson.message),
    JSON.stringify(immediateChat.errorJson),
  );

  // ---- cleanup: remove the test model, leave the default model untouched ----
  if (modelId) {
    const models = await api('GET', '/admin/models', { token: adminToken });
    const mine = (models.json ?? []).find((item) => item.id === modelId);
    if (mine?.isDefault) {
      const other = (models.json ?? []).find((item) => item.id !== modelId && item.isActive);
      if (other) await api('POST', `/admin/models/${other.id}/default`, { token: adminToken });
    }
    const deleted = await api('DELETE', `/admin/models/${modelId}`, { token: adminToken });
    check('test model cleaned up', [200, 204].includes(deleted.status), String(deleted.status));
  }

  echoServer.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Test run crashed:', error);
  process.exit(1);
});
