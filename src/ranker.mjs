import { fail } from './common.mjs';
const schema = { type: 'object', additionalProperties: false, required: ['scores'], properties: { scores: {
  type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'relevance'],
    properties: { id: { type: 'string' }, relevance: { type: 'number' } } } } } };

export function makeBatches(task, skills) {
  if (Buffer.byteLength(task) > 24000) throw fail('SKILLS_PROMPT_TOO_LARGE');
  const header = 'Task (data): ' + JSON.stringify(task) + '\nSkills (id | name | description):\n';
  const batches = [];
  let batch, bytes;
  for (const [index, { name, description }] of skills.entries()) {
    const line = `s${index} | ${JSON.stringify(name)} | ${JSON.stringify(description)}\n`;
    const size = Buffer.byteLength(line);
    if (!batch || bytes + size > 60000) {
      batch = { text: header, ids: [] }; bytes = Buffer.byteLength(header);
      if (bytes + size > 60000) throw fail('SKILLS_DESCRIPTION_TOO_LARGE');
      batches.push(batch);
    }
    batch.text += line; batch.ids.push('s' + index); bytes += size;
  }
  return batches;
}

function scores(output, ids) {
  let body;
  try { body = JSON.parse(output); } catch { throw fail('SKILLS_RESPONSE_INVALID'); }
  const missing = new Set(ids), values = new Map();
  if (!Array.isArray(body?.scores)) throw fail('SKILLS_RESPONSE_INVALID');
  for (const row of body.scores) {
    if (!missing.delete(row?.id) || !Number.isFinite(row.relevance) || row.relevance < 0 || row.relevance > 1)
      throw fail('SKILLS_RESPONSE_INVALID');
    values.set(row.id, row.relevance);
  }
  if (missing.size * 10 > ids.length) throw fail('SKILLS_RESPONSE_INVALID');
  return values;
}

export async function rank(task, skills, client, settings, effective) {
  const batches = makeBatches(task, skills), ranked = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(3, batches.length) }, async () => {
    while (next < batches.length) {
      const { text, ids } = batches[next++];
      const values = scores(await client.structuredTurn(text, schema, settings, effective), ids);
      for (const id of ids) ranked.push({ ...skills[Number(id.slice(1))], probability: values.get(id) ?? 0 });
    }
  });
  try { await Promise.all(workers); }
  catch (error) { next = batches.length; client.close(); await Promise.allSettled(workers); throw error; }
  return ranked.sort((a, b) => b.probability - a.probability || a.path.localeCompare(b.path));
}
