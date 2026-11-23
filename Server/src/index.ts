/// <reference path="../worker-configuration.d.ts" />

import { Hono } from 'hono'
import { cors } from 'hono/cors'

// Wrangler가 생성하는 CloudflareBindings에 D1(DB) 바인딩 타입이 정의되어 있어야 합니다.
const app = new Hono<{ Bindings: CloudflareBindings }>()
app.use('/api/*', cors({ origin: ['https://iot-glossary.pages.dev', 'http://localhost:5173'], allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'], allowHeaders: ['Content-Type'], maxAge: 86400 }))

const normalizeTags = (value: unknown): string[] => {
  if (Array.isArray(value)) return [...new Set(value.filter((tag): tag is string => typeof tag === 'string').map(tag => tag.trim()).filter(Boolean))]
  if (typeof value === 'string' && value.trim()) {
    try { const parsed: unknown = JSON.parse(value); if (Array.isArray(parsed)) return [...new Set(parsed.filter((tag): tag is string => typeof tag === 'string').map(tag => tag.trim()).filter(Boolean))] } catch {}
    return [...new Set(value.split(',').map(tag => tag.trim()).filter(Boolean))]
  }
  return []
}
const normalizeTerm = (term: any, linkedSlugs: string[] = []) => ({ ...term, category: typeof term.category === 'string' ? term.category : '', tags: normalizeTags(term.tags), linked_slugs: linkedSlugs })

app.get('/api/init', async c => {
  try {
    const db = c.env.DB
    await db.prepare(`CREATE TABLE IF NOT EXISTS terms (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, parent_slug TEXT, editor_name TEXT, category TEXT, tags TEXT NOT NULL DEFAULT '[]', updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`).run()
    const { results } = await db.prepare('PRAGMA table_info(terms)').all()
    const columns = (results || []).map((col: any) => col.name)
    if (!columns.includes('parent_slug')) await db.prepare('ALTER TABLE terms ADD COLUMN parent_slug TEXT').run()
    if (!columns.includes('editor_name')) await db.prepare('ALTER TABLE terms ADD COLUMN editor_name TEXT').run()
    if (!columns.includes('category')) await db.prepare('ALTER TABLE terms ADD COLUMN category TEXT').run()
    if (!columns.includes('tags')) await db.prepare("ALTER TABLE terms ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'").run()
    await db.prepare(`CREATE TABLE IF NOT EXISTS term_links (source_slug TEXT NOT NULL, target_slug TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(source_slug, target_slug), CHECK(source_slug < target_slug))`).run()
    await db.prepare('CREATE TABLE IF NOT EXISTS term_content_links (source_slug TEXT NOT NULL, target_slug TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(source_slug, target_slug))').run()
    // 기존 상/하위 관계를 방향 없는 링크로 1회성 호환 이전(중복은 무시)
    const { results: legacyTerms } = await db.prepare('SELECT slug, parent_slug FROM terms WHERE parent_slug IS NOT NULL AND parent_slug != \'\'').all()
    for (const term of (legacyTerms || []) as any[]) {
      for (const parent of String(term.parent_slug).split(',').map((s: string) => s.trim()).filter(Boolean)) {
        if (parent === term.slug) continue
        const [a, b] = [parent, term.slug].sort()
        await db.prepare('INSERT OR IGNORE INTO term_links (source_slug, target_slug) VALUES (?, ?)').bind(a, b).run()
      }
    }
    // 이전 방향 관계를 링크 테이블로 옮긴 뒤, 재마이그레이션으로 삭제한 링크가 되살아나지 않도록 비운다.
    await db.prepare("UPDATE terms SET parent_slug = NULL WHERE parent_slug IS NOT NULL AND parent_slug != ''").run()
    return c.json({ message: '데이터베이스 마이그레이션 완료' })
  } catch (err: any) { return c.json({ error: err.message }, 500) }
})

app.get('/api/terms', async c => {
  try {
    const db = c.env.DB
    await db.prepare('CREATE TABLE IF NOT EXISTS term_content_links (source_slug TEXT NOT NULL, target_slug TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(source_slug, target_slug))').run()
    const [{ results: rawTerms }, { results: legacyLinks }, { results: contentLinks }] = await Promise.all([
      db.prepare('SELECT * FROM terms ORDER BY id DESC').all(),
      db.prepare('SELECT source_slug, target_slug FROM term_links').all(),
      db.prepare('SELECT source_slug, target_slug FROM term_content_links').all()
    ])
    const allLinks = [...(legacyLinks || []), ...(contentLinks || [])]
    const terms = (rawTerms || []).map((term: any) => {
      const linked = allLinks.flatMap((link: any) => link.source_slug === term.slug ? [link.target_slug] : link.target_slug === term.slug ? [link.source_slug] : [])
      return normalizeTerm(term, [...new Set(linked)])
    })
    const slugToId = new Map(terms.map((term: any) => [term.slug, term.id]))
    const nodes = terms.map((term: any) => ({ id: term.id, slug: term.slug, title: term.title, category: term.category, tags: term.tags, linked_slugs: term.linked_slugs }))
    const edgeKeys = new Set<string>()
    const links = allLinks.flatMap((link: any) => {
      const source = slugToId.get(link.source_slug), target = slugToId.get(link.target_slug)
      if (source === undefined || target === undefined || source === target) return []
      const key = source < target ? source + ':' + target : target + ':' + source
      if (edgeKeys.has(key)) return []
      edgeKeys.add(key)
      return [{ source, target }]
    })
    return c.json({ terms, nodes, links })
  } catch (err: any) { return c.json({ error: err.message }, 500) }
})

app.get('/api/terms/:slug', async c => {
  try {
    const db = c.env.DB, slug = c.req.param('slug')
    await db.prepare('CREATE TABLE IF NOT EXISTS term_content_links (source_slug TEXT NOT NULL, target_slug TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(source_slug, target_slug))').run()
    const term: any = await db.prepare('SELECT * FROM terms WHERE slug = ?').bind(slug).first()
    if (!term) return c.json({ error: '문서를 찾을 수 없습니다.' }, 404)
    const [{ results: legacyLinks }, { results: contentLinks }] = await Promise.all([
      db.prepare('SELECT source_slug, target_slug FROM term_links WHERE source_slug = ? OR target_slug = ?').bind(slug, slug).all(),
      db.prepare('SELECT source_slug, target_slug FROM term_content_links WHERE source_slug = ? OR target_slug = ?').bind(slug, slug).all()
    ])
    const linked = [...(legacyLinks || []), ...(contentLinks || [])].map((link: any) => link.source_slug === slug ? link.target_slug : link.source_slug)
    return c.json({ term: normalizeTerm(term, [...new Set(linked)]) })
  } catch (err: any) { return c.json({ error: err.message }, 500) }
})

app.post('/api/terms', async c => {
  try {
    const db = c.env.DB
    await db.prepare('CREATE TABLE IF NOT EXISTS term_content_links (source_slug TEXT NOT NULL, target_slug TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(source_slug, target_slug))').run()
    const body = await c.req.json()
    const { slug, title, content, editor_name, category, tags, linked_slugs } = body
    if (!slug || !title || content === undefined || content === null) return c.json({ error: '필수 값이 누락되었습니다.' }, 400)
    const now = new Date().toISOString()
    await db.prepare('INSERT INTO terms (slug, title, content, editor_name, category, tags, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(slug) DO UPDATE SET title=excluded.title, content=excluded.content, editor_name=excluded.editor_name, category=excluded.category, tags=excluded.tags, updated_at=excluded.updated_at')
      .bind(slug, title, content, editor_name || '익명', typeof category === 'string' && category.trim() ? category.trim() : null, JSON.stringify(normalizeTags(tags)), now).run()

    // 문서 본문에서 정의한 링크는 source_slug별로 갱신한다. 역방향 링크는 건드리지 않는다.
    if (Array.isArray(linked_slugs)) {
      await db.prepare('DELETE FROM term_content_links WHERE source_slug = ?').bind(slug).run()
      const unique = [...new Set(linked_slugs.filter((s: unknown): s is string => typeof s === 'string' && s.length > 0 && s !== slug))]
      for (const other of unique) {
        await db.prepare('INSERT OR IGNORE INTO term_content_links (source_slug, target_slug) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM terms WHERE slug = ?)').bind(slug, other, other).run()
      }
    }
    return c.json({ message: '저장 완료', slug })
  } catch (err: any) { return c.json({ error: err.message }, 500) }
})

// 부하 테스트용 문서를 한 번의 API 요청으로 생성한다. 선택하면 20개 단위의 독립 그룹으로 연결한다.
app.post('/api/test-nodes', async c => {
  try {
    const body = await c.req.json()
    const count = Number(body?.count)
    const linkGroups = body?.linkGroups === true
    const groupSize = Number(body?.groupSize ?? 20)
    if (!Number.isInteger(count) || count < 1 || count > 10000) {
      return c.json({ error: '생성 개수는 1~10,000 사이의 정수여야 합니다.' }, 400)
    }
    if (linkGroups && (!Number.isInteger(groupSize) || groupSize < 2 || groupSize > 200)) {
      return c.json({ error: '그룹 크기는 2~200 사이의 정수여야 합니다.' }, 400)
    }

    const db = c.env.DB
    await db.prepare('CREATE TABLE IF NOT EXISTS term_content_links (source_slug TEXT NOT NULL, target_slug TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(source_slug, target_slug))').run()
    const batchId = crypto.randomUUID().replace(/-/g, '').slice(0, 12)
    const now = new Date().toISOString()
    const slugs = Array.from({ length: count }, (_, index) => `test-node-${batchId}-${index + 1}`)
    const statements = slugs.map((slug, index) => {
      const sequence = index + 1
      const title = `테스트 노드(${sequence})`
      return db.prepare(
        'INSERT INTO terms (slug, title, content, editor_name, category, tags, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(slug, title, '성능 테스트를 위해 자동 생성된 문서입니다.', '__load_test__', '테스트 데이터', '[]', now)
    })

    for (let index = 0; index < statements.length; index += 100) {
      await db.batch(statements.slice(index, index + 100))
    }

    let linkedEdges = 0
    if (linkGroups) {
      // 각 20개 단위 그룹의 첫 노드를 허브로 삼아 그룹 내부만 연결한다.
      // 전체 노드를 완전 연결하지 않아도 클러스터 구조를 만들면서 링크 수는 O(n)으로 유지한다.
      const linkStatements = slugs.flatMap((targetSlug, index) => {
        const groupStart = Math.floor(index / groupSize) * groupSize
        if (index === groupStart) return []
        return [
          db.prepare('INSERT OR IGNORE INTO term_content_links (source_slug, target_slug) VALUES (?, ?)')
            .bind(slugs[groupStart], targetSlug)
        ]
      })
      for (let index = 0; index < linkStatements.length; index += 100) {
        await db.batch(linkStatements.slice(index, index + 100))
      }
      linkedEdges = linkStatements.length
    }

    return c.json({
      message: '테스트 노드 생성 완료',
      created: count,
      batch_id: batchId,
      linked_groups: linkGroups ? Math.ceil(count / groupSize) : 0,
      linked_edges: linkedEdges,
      group_size: linkGroups ? groupSize : null
    })
  } catch (err: any) {
    return c.json({ error: err.message || '테스트 노드 생성에 실패했습니다.' }, 500)
  }
})

// 자동 생성한 부하 테스트 문서와 연결 관계만 일괄 정리한다.
app.delete('/api/test-nodes', async c => {
  try {
    const db = c.env.DB
    await db.prepare(`DELETE FROM term_links
      WHERE source_slug IN (SELECT slug FROM terms WHERE editor_name = '__load_test__')
         OR target_slug IN (SELECT slug FROM terms WHERE editor_name = '__load_test__')`).run()
    await db.prepare(`DELETE FROM term_content_links
      WHERE source_slug IN (SELECT slug FROM terms WHERE editor_name = '__load_test__')
         OR target_slug IN (SELECT slug FROM terms WHERE editor_name = '__load_test__')`).run()
    const result = await db.prepare("DELETE FROM terms WHERE editor_name = '__load_test__'").run()
    return c.json({ message: '테스트 노드 정리 완료', deleted: result.meta.changes || 0 })
  } catch (err: any) {
    return c.json({ error: err.message || '테스트 노드 정리에 실패했습니다.' }, 500)
  }
})

app.delete('/api/terms/:slug', async c => {
  try {
    const db = c.env.DB, slug = c.req.param('slug')
    await db.prepare('DELETE FROM term_links WHERE source_slug = ? OR target_slug = ?').bind(slug, slug).run()
    await db.prepare('DELETE FROM term_content_links WHERE source_slug = ? OR target_slug = ?').bind(slug, slug).run()
    await db.prepare('DELETE FROM terms WHERE slug = ?').bind(slug).run()
    return c.json({ message: '삭제 완료', slug })
  } catch (err: any) { return c.json({ error: err.message }, 500) }
})

export default app
