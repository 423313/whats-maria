import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationPath = new URL('../supabase/migrations/central_flora_outbox.sql', import.meta.url);

describe('migração da outbox CRM', () => {
  it('deduplica pendências por assunto antes do índice único sem apagar dados', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    const dedupeStart = sql.indexOf('with pending_subject_duplicates as');
    const indexStart = sql.indexOf('create unique index if not exists crm_request_outbox_pending_subject_idx');

    expect(dedupeStart).toBeGreaterThanOrEqual(0);
    expect(indexStart).toBeGreaterThan(dedupeStart);

    const dedupeSql = sql.slice(dedupeStart, indexStart);
    expect(dedupeSql).toMatch(/row_number\(\) over\s*\(\s*partition by assunto_chave/i);
    expect(dedupeSql).toMatch(/status\s*=\s*'pendente'/i);
    expect(dedupeSql).toMatch(/status\s*=\s*'erro_permanente'/i);
    expect(dedupeSql).toMatch(/ultimo_erro\s*=\s*'[^']*deduplic/i);
    expect(dedupeSql).not.toMatch(/\bdelete\s+from\b/i);
  });
});
