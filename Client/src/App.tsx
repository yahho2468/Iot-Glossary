import React, { useEffect, useMemo, useRef, useState } from 'react'
import * as d3 from 'd3'

interface Node {
  id: number
  slug: string
  title: string
  parent_slug?: string | null
  category?: string
  tags?: string[]
  linked_slugs?: string[]
  x?: number
  y?: number
  vx?: number
  vy?: number
  fx?: number | null
  fy?: number | null
}

interface Link {
  source: number | Node
  target: number | Node
}

interface TermDetail {
  id: number
  slug: string
  title: string
  content: string
  parent_slug?: string | null
  linked_slugs?: string[]
  category?: string | null
  tags?: string[] | string | null
  updated_at: string
}

const NODE_RADIUS = 14

// 카테고리 이름별 색상을 안정적으로 배정한다. 서로 다른 카테고리는 가능한 한 다른 색조를 사용한다.
const buildCategoryColorMap = (values: string[]) => {
  const categories = [...new Set(values.map(value => value.trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'ko'))
  const usedHues = new Set<number>()
  const colors = new Map<string, string>()

  categories.forEach(category => {
    let hash = 0
    for (let index = 0; index < category.length; index++) {
      hash = (hash * 31 + category.charCodeAt(index)) | 0
    }
    let hue = Math.abs(hash) % 360
    let attempts = 0
    while (usedHues.has(Math.round(hue)) && attempts < 360) {
      hue = (hue + 137.508) % 360
      attempts++
    }
    hue = Math.round(hue)
    usedHues.add(hue)
    colors.set(category, `hsl(${hue}, 68%, 43%)`)
  })

  return colors
}

const parseTags = (value?: string[] | string | null): string[] => {
  let values: string[] = []
  if (Array.isArray(value)) {
    values = value
  } else if (typeof value === 'string' && value.trim()) {
    try {
      const parsed: unknown = JSON.parse(value)
      values = Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : value.split(',')
    } catch {
      values = value.split(',')
    }
  }
  return [...new Set(values.map(tag => tag.trim()).filter(Boolean))]
}

const normalizeTerm = (term: any): TermDetail => ({
  ...term,
  category: typeof term.category === 'string' ? term.category : '',
  tags: parseTags(term.tags),
  linked_slugs: Array.isArray(term.linked_slugs) ? term.linked_slugs : [],
})

// Markdown 렌더링: 기존 contentEditable에서 저장한 HTML 문서도 호환한다.
const escapeHtml = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')

const safeExternalUrl = (value: string) => /^(https?:\/\/|data:image\/(png|jpeg|gif|webp|svg\+xml);base64,)/i.test(value)
  ? value
  : ''

const renderInlineMarkdown = (source: string) => {
  let text = escapeHtml(source)
  const tokens: string[] = []
  const keep = (html: string) => {
    const key = `\u0000MD${tokens.length}\u0000`
    tokens.push(html)
    return key
  }

  // 코드, 이미지, 일반 링크를 먼저 보호해 내부 문자열이 Jira 링크로 중복 변환되지 않게 한다.
  text = text.replace(/`([^`]+)`/g, (_match, code) => keep(`<code>${code}</code>`))
  text = text.replace(/!\[([^\]]*)\]\(([^\s)]+)(?:\s+"([^"]*)")?\)/g, (_match, alt, rawUrl, title) => {
    const url = safeExternalUrl(rawUrl)
    return url ? keep(`<img src="${escapeHtml(url)}" alt="${alt}"${title ? ` title="${title}"` : ''} style="max-width:100%;max-height:450px;border-radius:12px;margin:12px 0" />`) : alt
  })
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)(?:\s+"([^"]*)")?\)/g, (_match, label, url, title) =>
    keep(`<a href="${escapeHtml(url)}"${title ? ` title="${title}"` : ''} target="_blank" rel="noopener noreferrer" style="color:#2563eb;text-decoration:underline">${label}</a>`)
  )
  text = text.replace(/\b([A-Z][A-Z0-9]{1,19}-\d+)\b/g, (_match, issueKey) => {
    const url = `https://suholab.atlassian.net/browse/${issueKey}`
    return keep(`<a href="${url}" target="_blank" rel="noopener noreferrer" class="jira-issue-link" style="color:#2563eb;text-decoration:underline;font-weight:600">${issueKey}</a>`)
  })
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  text = text.replace(/__(.+?)__/g, '<strong>$1</strong>')
  text = text.replace(/~~(.+?)~~/g, '<del>$1</del>')
  text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
  text = text.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>')
  return text.replace(/\u0000MD(\d+)\u0000/g, (_match, index) => tokens[Number(index)] || '')
}

const markdownToHtml = (source: string) => {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const output: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }

    if (/^\s*```/.test(line)) {
      const language = line.replace(/^\s*```/, '').trim().replace(/[^a-zA-Z0-9+#._-]/g, '')
      i++
      const code: string[] = []
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++])
      if (i < lines.length) i++
      output.push(`<pre><code${language ? ` class="language-${language}"` : ''}>${escapeHtml(code.join('\n'))}</code></pre>`)
      continue
    }

    // Markdown 표: 헤더 행 다음에 | --- | 구분선이 오는 기본 형식을 지원한다.
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
      const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim())
      const headers = cells(line)
      i += 2
      const bodyRows: string[][] = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) bodyRows.push(cells(lines[i++]))
      output.push(`<div class="overflow-x-auto"><table><thead><tr>${headers.map(cell => `<th>${renderInlineMarkdown(cell)}</th>`).join('')}</tr></thead><tbody>${bodyRows.map(row => `<tr>${headers.map((_cell, index) => `<td>${renderInlineMarkdown(row[index] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`)
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      const level = heading[1].length
      output.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`)
      i++
      continue
    }
    if (/^\s*(---+|\*\*\*|___)\s*$/.test(line)) {
      output.push('<hr />'); i++; continue
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''))
      output.push(`<blockquote>${quote.map(item => `<p>${renderInlineMarkdown(item)}</p>`).join('')}</blockquote>`)
      continue
    }
    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line)
      const items: string[] = []
      const pattern = ordered ? /^\s*\d+\.\s+/ : /^\s*[-*+]\s+/
      while (i < lines.length && pattern.test(lines[i])) items.push(`<li>${renderInlineMarkdown(lines[i++].replace(pattern, ''))}</li>`)
      output.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`)
      continue
    }

    const paragraph: string[] = []
    while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^#{1,6}\s+/.test(lines[i]) && !/^\s*>/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i]) && !/^\s*(---+|\*\*\*|___)\s*$/.test(lines[i])) {
      paragraph.push(lines[i++])
    }
    output.push(`<p>${paragraph.map(renderInlineMarkdown).join('<br />')}</p>`)
  }
  return output.join('\n')
}

// 예전 에디터가 저장한 HTML을 유지하되 허용된 태그/속성만 남겨 안전하게 표시한다.
const sanitizeLegacyHtml = (html: string) => {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const allowedTags = new Set(['P','DIV','BR','H1','H2','H3','H4','H5','H6','STRONG','B','EM','I','U','S','DEL','UL','OL','LI','BLOCKQUOTE','PRE','CODE','A','IMG','HR','TABLE','THEAD','TBODY','TR','TH','TD','SPAN'])
  const removeTags = new Set(['SCRIPT','STYLE','IFRAME','OBJECT','EMBED','FORM','INPUT','BUTTON','SVG','MATH'])
  Array.from(doc.body.querySelectorAll('*')).reverse().forEach(element => {
    if (removeTags.has(element.tagName)) { element.remove(); return }
    if (!allowedTags.has(element.tagName)) { element.replaceWith(...Array.from(element.childNodes)); return }
    Array.from(element.attributes).forEach(attribute => {
      const name = attribute.name.toLowerCase()
      const value = attribute.value
      const allowed = ['href','src','alt','title','width','height','colspan','rowspan','class'].includes(name)
      if (!allowed || name.startsWith('on')) { element.removeAttribute(attribute.name); return }
      if ((name === 'href' && !/^https?:\/\//i.test(value)) || (name === 'src' && !safeExternalUrl(value))) element.removeAttribute(attribute.name)
    })
    if (element.tagName === 'A') { element.setAttribute('target', '_blank'); element.setAttribute('rel', 'noopener noreferrer') }
    if (element.tagName === 'IMG') element.setAttribute('style', 'max-width:100%;max-height:450px;border-radius:12px')
  })
  // 기존 HTML 본문에 있던 Jira 이슈 키도 자동 링크 처리한다(코드 블록과 이미 링크된 텍스트는 제외).
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
  const textNodes: Text[] = []
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text)
  const issuePattern = /\b([A-Z][A-Z0-9]{1,19}-\d+)\b/g
  textNodes.forEach(textNode => {
    const parent = textNode.parentElement
    if (!parent || parent.closest('a, code, pre')) return
    const value = textNode.nodeValue || ''
    issuePattern.lastIndex = 0
    if (!issuePattern.test(value)) return
    issuePattern.lastIndex = 0
    const fragment = doc.createDocumentFragment()
    let lastIndex = 0
    for (const match of value.matchAll(issuePattern)) {
      const issueKey = match[1]
      const start = match.index ?? 0
      fragment.append(doc.createTextNode(value.slice(lastIndex, start)))
      const anchor = doc.createElement('a')
      anchor.href = `https://suholab.atlassian.net/browse/${issueKey}`
      anchor.target = '_blank'
      anchor.rel = 'noopener noreferrer'
      anchor.className = 'jira-issue-link'
      anchor.textContent = issueKey
      anchor.setAttribute('style', 'color:#2563eb;text-decoration:underline;font-weight:600')
      fragment.append(anchor)
      lastIndex = start + issueKey.length
    }
    fragment.append(doc.createTextNode(value.slice(lastIndex)))
    textNode.replaceWith(fragment)
  })
  return doc.body.innerHTML
}

const renderDocumentHtml = (content: string) => {
  if (!content) return '<p class="text-slate-400 italic">작성된 내용이 없습니다.</p>'
  const containsLegacyHtml = /<\/?(p|div|h[1-6]|ul|ol|li|br|img|strong|em|a|span|table|blockquote|pre)\b/i.test(content)
  return containsLegacyHtml ? sanitizeLegacyHtml(content) : markdownToHtml(content)
}

// 상시 가동 중인 Cloudflare Worker 백엔드 주소
const API_BASE_URL = 'https://iot-glossary.smh13918957.workers.dev' 

export default function App() {
  const minimapRef = useRef<SVGSVGElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const editorRef = useRef<HTMLDivElement | null>(null)
  const editorRangeRef = useRef<Range | null>(null)
  const graphPositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map())

  const [nodes, setNodes] = useState<Node[]>([])
  const [links, setLinks] = useState<Link[]>([])
  const [allTerms, setAllTerms] = useState<TermDetail[]>([])
  const [selectedTerm, setSelectedTerm] = useState<TermDetail | null>(null)
  
  // 화면 뷰 상태 ('home' | 'list' | 'detail' | 'edit')
  const [currentView, setCurrentView] = useState<'home' | 'list' | 'detail' | 'edit'>('home')
  const [previousView, setPreviousView] = useState<'home' | 'list'>('home')
  
  // 최근 방문 페이지 슬러그 목록 관리 (최대 4개)
  const [recentSlugs, setRecentSlugs] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('iot_recent_slugs')
      return saved ? JSON.parse(saved) : []
    } catch {
      return []
    }
  })
  
  // 신규 문서 작성 중 취소 시 삭제 판별을 위한 플래그
  const [isNewDraft, setIsNewDraft] = useState(false)
  
  // 검색 및 목록 필터 상태 (제목·카테고리·태그 통합 검색)
  const [searchQuery, setSearchQuery] = useState('')
  const [listSearchQuery, setListSearchQuery] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('all')
  
  // 문서 생성 모달 상태
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [selectedLinkedSlugs, setSelectedLinkedSlugs] = useState<string[]>([])
  const [newCategory, setNewCategory] = useState('')
  const [newTagsText, setNewTagsText] = useState('')
  const [createLinkSearch, setCreateLinkSearch] = useState('')

  // 문서 편집/작성 상태
  const [editSlug, setEditSlug] = useState('')
  const [editTitle, setEditTitle] = useState('')
  const [editContent, setEditContent] = useState('')
  const [editLinkedSlugs, setEditLinkedSlugs] = useState<string[]>([])
  const [editCategory, setEditCategory] = useState('')
  const [editTagsText, setEditTagsText] = useState('')

  // 문서 설정 변경 모달 상태
  const [isMetaModalOpen, setIsMetaModalOpen] = useState(false)
  const [tempTitle, setTempTitle] = useState('')
  const [tempLinkedSlugs, setTempLinkedSlugs] = useState<string[]>([])
  const [tempCategory, setTempCategory] = useState('')
  const [tempTagsText, setTempTagsText] = useState('')
  const [metaLinkSearch, setMetaLinkSearch] = useState('')

  // 삭제 확인 모달 상태
  const [deleteTargetSlug, setDeleteTargetSlug] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')

  const categoryColorMap = useMemo(
    () => buildCategoryColorMap(allTerms.map(term => (term.category || '').trim())),
    [allTerms]
  )
  const getCategoryColor = (category?: string | null) => {
    const normalized = (category || '').trim()
    return normalized ? categoryColorMap.get(normalized) || '#64748b' : '#94a3b8'
  }

  // 데이터 로드 및 반지름 동기화
  const fetchData = async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/terms`)
      if (!res.ok) throw new Error(`용어 목록을 불러오지 못했습니다. (${res.status})`)
      const data = await res.json()
      if (data && data.nodes) {
        const normalizedTerms: TermDetail[] = (data.terms || []).map(normalizeTerm)
        const termsBySlug = new Map(normalizedTerms.map(term => [term.slug, term]))
        const rawNodes: Node[] = data.nodes
        const rawLinks: Link[] = data.links || []
        const processedNodes = rawNodes.map(node => {
          const term = termsBySlug.get(node.slug)
          return {
            ...node,
            category: term?.category || node.category || '',
            tags: term ? parseTags(term.tags) : parseTags(node.tags as any),
          }
        })
        setNodes(processedNodes)
        setLinks(rawLinks)
        setAllTerms(normalizedTerms.length ? normalizedTerms : processedNodes.map(normalizeTerm))
      }
    } catch (err) {
      console.error("데이터 로드 실패:", err)
    }
  }

  useEffect(() => {
    fetchData()
  }, [])

  // 상세 보기 화면에서 Ctrl + Delete 키 입력 시 문서 삭제 단축키 처리
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && (e.key === 'Delete' || e.code === 'Delete')) {
        if (currentView === 'detail' && selectedTerm) {
          e.preventDefault()
          handleDelete(selectedTerm.slug)
        }
      }
    }
    window.addEventListener('keydown', handleGlobalKeyDown)
    return () => window.removeEventListener('keydown', handleGlobalKeyDown)
  }, [currentView, selectedTerm])

  // 편집 화면 진입 시 저장된 Markdown/HTML을 편집 가능한 리치 텍스트로 표시한다.
  useEffect(() => {
    if (currentView !== 'edit' || !editorRef.current) return
    const editor = editorRef.current
    editor.innerHTML = editContent ? renderDocumentHtml(editContent) : '<p><br></p>'
    editor.focus()
    const selection = window.getSelection()
    if (selection) {
      const range = document.createRange()
      range.selectNodeContents(editor)
      range.collapse(false)
      selection.removeAllRanges()
      selection.addRange(range)
      editorRangeRef.current = range.cloneRange()
    }
  }, [currentView, editSlug])

  // 최근 방문 페이지 기록 함수
  const addRecentSlug = (slug: string) => {
    setRecentSlugs(prev => {
      const filtered = prev.filter(s => s !== slug)
      const updated = [slug, ...filtered].slice(0, 4)
      try {
        localStorage.setItem('iot_recent_slugs', JSON.stringify(updated))
      } catch {}
      return updated
    })
  }

  // 특정 용어 상세 조회
  const fetchTermDetail = async (slug: string) => {
    if (currentView !== 'detail' && currentView !== 'edit') {
      setPreviousView(currentView === 'list' ? 'list' : 'home')
    }
    try {
      const res = await fetch(`${API_BASE_URL}/api/terms/${encodeURIComponent(slug)}`)
      if (!res.ok) throw new Error(`문서를 불러오지 못했습니다. (${res.status})`)
      const data = await res.json()
      if (data.term) {
        setSelectedTerm(normalizeTerm(data.term))
        setCurrentView('detail')
        setSearchQuery('')
        addRecentSlug(slug)
      }
    } catch (err) {
      console.error("상세 조회 실패:", err)
    }
  }

  // 그래프뷰: 좌표 캐시, 시뮬레이션 정리, 노드 그룹 단일 transform으로 렌더링 비용을 줄인다.
  useEffect(() => {
    if (!minimapRef.current) return

    const svg = d3.select(minimapRef.current)
    svg.selectAll('*').remove()
    if (currentView === 'home' || nodes.length === 0) return

    const width = 340
    const height = 340
    const activeSlug = selectedTerm?.slug || editSlug
    let relevantNodes = nodes
    let relevantLinks = links

    if ((currentView === 'detail' || currentView === 'edit') && activeSlug) {
      const activeTerm = allTerms.find(term => term.slug === activeSlug)
      const linkedSlugs = new Set(
        currentView === 'edit' && editSlug === activeSlug
          ? editLinkedSlugs
          : activeTerm?.linked_slugs || []
      )
      relevantNodes = nodes.filter(node => node.slug === activeSlug || linkedSlugs.has(node.slug))
      const relevantNodeIds = new Set(relevantNodes.map(node => node.id))
      relevantLinks = links.filter(link => {
        const sourceId = typeof link.source === 'object' ? link.source.id : link.source
        const targetId = typeof link.target === 'object' ? link.target.id : link.target
        return relevantNodeIds.has(sourceId) && relevantNodeIds.has(targetId)
      })
    }

    if (relevantNodes.length === 0) return

    // React 상태 객체를 D3가 직접 변경하지 않도록 복사하고, 이전 위치는 slug 기준으로 재사용한다.
    const simulationNodes: Node[] = relevantNodes.map(node => {
      const cached = graphPositionsRef.current.get(node.slug)
      return {
        ...node,
        x: cached?.x ?? node.x,
        y: cached?.y ?? node.y,
        vx: 0,
        vy: 0,
        fx: null,
        fy: null
      }
    })
    const simulationLinks = relevantLinks.map(link => ({
      source: typeof link.source === 'object' ? link.source.id : link.source,
      target: typeof link.target === 'object' ? link.target.id : link.target
    }))

    const container = svg.append('g')
    const nodeCount = simulationNodes.length
    const labelThreshold = 160
    let nodeGroups: any = null
    let allLabelsCreated = nodeCount <= labelThreshold

    const ensureLabels = (includeAll: boolean) => {
      if (!nodeGroups) return
      nodeGroups.each(function(this: SVGGElement, d: Node) {
        if (!includeAll && d.slug !== activeSlug) return
        const group = d3.select(this)
        if (!group.select('text').empty()) return
        group.append('text')
          .text(d.title)
          .attr('x', NODE_RADIUS + 5)
          .attr('y', 4)
          .attr('fill', '#1e293b')
          .attr('font-size', '11px')
          .attr('font-family', '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif')
          .attr('font-weight', 500)
          .style('pointer-events', 'none')
      })
    }

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.12, 4])
      .on('zoom', event => {
        container.attr('transform', event.transform)
        const showLabels = nodeCount <= labelThreshold || event.transform.k >= 1.25
        if (showLabels && !allLabelsCreated) {
          ensureLabels(true)
          allLabelsCreated = true
        }
        nodeGroups?.select('text').style('display', (d: Node) => showLabels || d.slug === activeSlug ? null : 'none')
      })
    svg.call(zoom as any)

    const simulation = d3.forceSimulation(simulationNodes as d3.SimulationNodeDatum[])
      .alpha(0.75)
      .alphaDecay(0.085)
      .velocityDecay(0.45)
      .force('link', d3.forceLink(simulationLinks as any).id((d: any) => d.id).distance(100).iterations(1))
      .force('charge', d3.forceManyBody().strength(-175).distanceMax(260).theta(0.9))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collide', d3.forceCollide().radius(NODE_RADIUS + 13).iterations(1))

    const linkSelection = container.append('g')
      .attr('stroke', '#cbd5e1')
      .attr('stroke-opacity', 0.8)
      .attr('stroke-width', 1.35)
      .selectAll('line')
      .data(simulationLinks)
      .join('line')

    nodeGroups = container.append('g')
      .selectAll<SVGGElement, Node>('g')
      .data(simulationNodes)
      .join('g')
      .attr('class', 'graph-node')
      .style('cursor', 'grab')
      .call(d3.drag<SVGGElement, Node>()
        .on('start', (event, d) => {
          if (!event.active) simulation.alphaTarget(0.22).restart()
          d.fx = d.x ?? 0
          d.fy = d.y ?? 0
          d3.select(event.sourceEvent.target.closest('g') || event.sourceEvent.target.parentNode).raise()
        })
        .on('drag', (event, d) => {
          d.fx = event.x
          d.fy = event.y
        })
        .on('end', (event, d) => {
          if (!event.active) simulation.alphaTarget(0)
          d.fx = null
          d.fy = null
          if (typeof d.x === 'number' && typeof d.y === 'number') graphPositionsRef.current.set(d.slug, { x: d.x, y: d.y })
        })
      )

    nodeGroups.append('circle')
      .attr('r', NODE_RADIUS)
      .attr('fill', (d: Node) => getCategoryColor(d.category))
      .attr('stroke', (d: Node) => d.slug === activeSlug ? '#1d4ed8' : '#ffffff')
      .attr('stroke-width', (d: Node) => d.slug === activeSlug ? 3 : 1.75)
      .append('title')
      .text((d: Node) => `${d.title} · ${d.category || '카테고리 없음'}`)

    ensureLabels(nodeCount <= labelThreshold)

    nodeGroups.on('click', (event: any, d: Node) => {
      event.stopPropagation()
      fetchTermDetail(d.slug)
    })

    const fitView = () => {
      const positioned = simulationNodes.filter(node => Number.isFinite(node.x) && Number.isFinite(node.y))
      if (!positioned.length) return
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
      positioned.forEach(node => {
        x0 = Math.min(x0, node.x as number)
        x1 = Math.max(x1, node.x as number)
        y0 = Math.min(y0, node.y as number)
        y1 = Math.max(y1, node.y as number)
      })
      const boundsWidth = Math.max(1, x1 - x0)
      const boundsHeight = Math.max(1, y1 - y0)
      const scale = Math.min(1.2, Math.max(0.18, 0.86 / Math.max(boundsWidth / width, boundsHeight / height)))
      const midX = (x0 + x1) / 2
      const midY = (y0 + y1) / 2
      svg.call(zoom.transform as any, d3.zoomIdentity
        .translate(width / 2 - scale * midX, height / 2 - scale * midY)
        .scale(scale))
    }

    simulation.on('tick', () => {
      linkSelection
        .attr('x1', (d: any) => d.source.x)
        .attr('y1', (d: any) => d.source.y)
        .attr('x2', (d: any) => d.target.x)
        .attr('y2', (d: any) => d.target.y)
      nodeGroups.attr('transform', (d: Node) => `translate(${d.x ?? width / 2}, ${d.y ?? height / 2})`)
    })

    simulation.on('end', () => {
      fitView()
      simulationNodes.forEach(node => {
        if (typeof node.x === 'number' && typeof node.y === 'number') {
          graphPositionsRef.current.set(node.slug, { x: node.x, y: node.y })
        }
      })
    })

    return () => {
      simulation.stop()
      simulationNodes.forEach(node => {
        if (typeof node.x === 'number' && typeof node.y === 'number') {
          graphPositionsRef.current.set(node.slug, { x: node.x, y: node.y })
        }
      })
      svg.on('.zoom', null)
      svg.selectAll('*').remove()
    }
  }, [nodes, links, currentView, selectedTerm?.slug, editSlug, editLinkedSlugs, allTerms, categoryColorMap])

  // 내용 작성 탭 진입 시점에 정식 노드 생성
  const handleProceedToEdit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    if (!newTitle.trim()) return

    let baseSlug = newTitle.trim().toLowerCase().replace(/[^a-z0-9가-힣]+/g, '-')
    if (!baseSlug || baseSlug === '-') {
      baseSlug = 'term'
    }
    const slug = baseSlug + '-' + Date.now().toString().slice(-4)

    try {
      const res = await fetch(`${API_BASE_URL}/api/terms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: slug,
          title: newTitle,
          content: '', 
          category: newCategory.trim() || null,
          tags: parseTags(newTagsText),
          linked_slugs: selectedLinkedSlugs
        })
      })

      if (res.ok) {

        setIsModalOpen(false)
        setIsNewDraft(true)
        await fetchData()
        
        const detailRes = await fetch(`${API_BASE_URL}/api/terms/${slug}`)
        const detailData = await detailRes.json()
        if (detailData.term) {
          const term = normalizeTerm(detailData.term)
          setSelectedTerm(term)
          setEditSlug(term.slug)
          setEditTitle(term.title)
          setEditContent(term.content)
          setEditLinkedSlugs(term.linked_slugs || [])
          setEditCategory(term.category || '')
          setEditTagsText(parseTags(term.tags).join(', '))
          setCurrentView('edit')
        }
      } else {
        const errData = await res.json().catch(() => ({}))
        alert("문서 생성에 실패했습니다: " + (errData.error || res.statusText))
      }
    } catch (err) {
      console.error("생성 에러:", err)
      alert("서버 통신 중 오류가 발생했습니다.")
    }
  }

  // 문서 저장
  const handleSaveEdit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault()

    try {
      const res = await fetch(`${API_BASE_URL}/api/terms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: editSlug,
          title: editTitle,
          content: editorRef.current?.innerHTML ?? editContent,
          category: editCategory.trim() || null,
          tags: parseTags(editTagsText),
          linked_slugs: editLinkedSlugs
        })
      })

      if (res.ok) {
        setIsNewDraft(false)
        alert("문서가 성공적으로 저장되었습니다.")
        await fetchData()
        fetchTermDetail(editSlug)
      } else {
        alert("저장에 실패했습니다.")
      }
    } catch (err) {
      console.error("저장 에러:", err)
    }
  }

  // 작성 중 취소 처리
  const handleCancelEdit = async () => {
    if (isNewDraft) {
      try {
        await fetch(`${API_BASE_URL}/api/terms/${editSlug}`, {
          method: 'DELETE'
        })
        await fetchData()
      } catch (err) {
        console.error("임시 문서 삭제 실패:", err)
      }
      setIsNewDraft(false)
      setSelectedTerm(null)
      setCurrentView(previousView)
    } else {
      fetchTermDetail(editSlug)
    }
  }

  // 삭제 버튼을 누르면 브라우저 알림 대신 앱 내부 확인 모달을 연다.
  const handleDelete = (slug: string) => {
    setDeleteTargetSlug(slug)
    setDeleteError('')
  }

  const confirmDelete = async () => {
    if (!deleteTargetSlug || isDeleting) return
    setIsDeleting(true)
    setDeleteError('')
    try {
      const res = await fetch(`${API_BASE_URL}/api/terms/${encodeURIComponent(deleteTargetSlug)}`, {
        method: 'DELETE'
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `삭제에 실패했습니다. (${res.status})`)
      }
      await fetchData()
      setDeleteTargetSlug(null)
      setSelectedTerm(null)
      setCurrentView(previousView)
    } catch (err) {
      console.error("삭제 에러:", err)
      setDeleteError(err instanceof Error ? err.message : '삭제 중 오류가 발생했습니다.')
    } finally {
      setIsDeleting(false)
    }
  }

  // 수정 모드 진입
  const openEditView = () => {
    if (!selectedTerm) return
    setIsNewDraft(false)
    setEditSlug(selectedTerm.slug)
    setEditTitle(selectedTerm.title)
    setEditContent(selectedTerm.content)
    setEditLinkedSlugs(selectedTerm.linked_slugs || [])
    setEditCategory(selectedTerm.category || '')
    setEditTagsText(parseTags(selectedTerm.tags).join(', '))
    setCurrentView('edit')
  }

  // 새 문서 모달 열기
  const openCreateModal = () => {
    setNewTitle('')
    setSelectedLinkedSlugs([])
    setNewCategory('')
    setNewTagsText('')
    setCreateLinkSearch('')
    if (currentView === 'detail' && selectedTerm) setSelectedLinkedSlugs([selectedTerm.slug])
    setIsModalOpen(true)
  }

  // 편집기 커서/선택 영역을 기억해 이미지 업로드 이후에도 삽입 위치를 유지한다.
  const rememberEditorSelection = () => {
    const editor = editorRef.current
    const selection = window.getSelection()
    if (!editor || !selection || selection.rangeCount === 0) return
    const range = selection.getRangeAt(0)
    if (editor.contains(range.commonAncestorContainer)) editorRangeRef.current = range.cloneRange()
  }

  const updateEditorContent = () => {
    if (editorRef.current) setEditContent(editorRef.current.innerHTML)
    rememberEditorSelection()
  }

  const insertNodeAtEditorCursor = (node: globalThis.Node) => {
    const editor = editorRef.current
    if (!editor) return
    editor.focus()
    const selection = window.getSelection()
    let range = editorRangeRef.current?.cloneRange() || (selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null)
    if (!range || !editor.contains(range.commonAncestorContainer)) {
      range = document.createRange()
      range.selectNodeContents(editor)
      range.collapse(false)
    }
    range.deleteContents()
    const lastInsertedNode = node.nodeType === 11 ? node.lastChild : node
    range.insertNode(node)
    if (lastInsertedNode && lastInsertedNode.parentNode) range.setStartAfter(lastInsertedNode)
    else range.selectNodeContents(editor)
    range.collapse(true)
    selection?.removeAllRanges()
    selection?.addRange(range)
    editorRangeRef.current = range.cloneRange()
    setEditContent(editor.innerHTML)
  }

  const insertPlainTextAtEditorCursor = (value: string) => {
    const fragment = document.createDocumentFragment()
    const parts = value.replace(/\r\n?/g, '\n').split('\n')
    parts.forEach((part, index) => {
      if (index > 0) fragment.append(document.createElement('br'))
      if (part) fragment.append(document.createTextNode(part))
    })
    insertNodeAtEditorCursor(fragment)
  }

  const setEditorCaret = (node: globalThis.Node, offset = 0) => {
    const selection = window.getSelection()
    if (!selection) return
    const range = document.createRange()
    range.setStart(node, offset)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
    editorRangeRef.current = range.cloneRange()
  }

  // 스페이스 입력 시 Markdown 단축 표기와 Jira 이슈 키를 현재 입력 위치에서 실제 서식으로 변환한다.
  const handleEditorKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault()
      handleSaveEdit()
      return
    }
    if (event.key !== ' ') return

    const editor = editorRef.current
    const selection = window.getSelection()
    if (!editor || !selection || selection.rangeCount === 0 || !selection.isCollapsed) return
    const range = selection.getRangeAt(0)
    const textNode = range.startContainer
    if (textNode.nodeType !== 3) return
    const text = textNode.nodeValue || ''
    const offset = range.startOffset
    const before = text.slice(0, offset)
    const after = text.slice(offset)

    const parentElement = (textNode as Text).parentElement
    const block = parentElement?.closest('p,div,h1,h2,h3,h4,h5,h6,blockquote,li') as HTMLElement | null
    const blockText = block?.textContent || text
    const marker = before.match(/^(#{1,3}|[-*+]|\d+\.|>)$/)

    if (marker && blockText.trim() === marker[0] && !after.trim()) {
      event.preventDefault()
      const token = marker[0]
      let replacement: HTMLElement
      if (/^#{1,3}$/.test(token)) {
        replacement = document.createElement(`h${token.length}`)
      } else if (/^\d+\.$/.test(token)) {
        replacement = document.createElement('ol')
        const item = document.createElement('li')
        item.innerHTML = '<br>'
        replacement.append(item)
      } else if (token === '>') {
        replacement = document.createElement('blockquote')
        replacement.innerHTML = '<p><br></p>'
      } else {
        replacement = document.createElement('ul')
        const item = document.createElement('li')
        item.innerHTML = '<br>'
        replacement.append(item)
      }
      if (replacement.tagName.startsWith('H')) replacement.innerHTML = '<br>'
      if (block && block !== editor) block.replaceWith(replacement)
      else (textNode as Text).replaceWith(replacement)
      const caretTarget = replacement.querySelector('li, p') || replacement
      setEditorCaret(caretTarget, 0)
      setEditContent(editor.innerHTML)
      return
    }

    const inlinePatterns: Array<{ regex: RegExp; tag: string }> = [
      { regex: /\*\*([^*\n]+)\*\*$/, tag: 'strong' },
      { regex: /__([^_\n]+)__$/, tag: 'strong' },
      { regex: /~~([^~\n]+)~~$/, tag: 'del' },
      { regex: /`([^`\n]+)`$/, tag: 'code' },
      { regex: /\*([^*\n]+)\*$/, tag: 'em' },
      { regex: /_([^_\n]+)_$/, tag: 'em' }
    ]
    let matched: { index: number; value: string; tag: string } | null = null
    let linkUrl = ''
    for (const item of inlinePatterns) {
      const match = before.match(item.regex)
      if (match && match.index !== undefined) {
        matched = { index: match.index, value: match[1], tag: item.tag }
        break
      }
    }

    // [링크 이름](https://...) 형식도 공백 입력 시 실제 링크 요소로 바꾼다.
    if (!matched && !parentElement?.closest('a,code,pre')) {
      const markdownLink = before.match(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)(?:\s+"([^"]*)")?\)$/)
      if (markdownLink && markdownLink.index !== undefined) {
        matched = { index: markdownLink.index, value: markdownLink[1], tag: 'a' }
        linkUrl = markdownLink[2]
      }
    }

    let isJira = false
    if (!matched && !parentElement?.closest('a,code,pre')) {
      const jiraMatch = before.match(/\b([A-Z][A-Z0-9]{1,19}-\d+)$/)
      if (jiraMatch && jiraMatch.index !== undefined) {
        matched = { index: jiraMatch.index, value: jiraMatch[1], tag: 'a' }
        linkUrl = `https://suholab.atlassian.net/browse/${jiraMatch[1]}`
        isJira = true
      }
    }
    if (!matched) return

    event.preventDefault()
    const fragment = document.createDocumentFragment()
    const prefix = before.slice(0, matched.index)
    if (prefix) fragment.append(document.createTextNode(prefix))
    const formatted = document.createElement(matched.tag)
    formatted.textContent = matched.value
    if (isJira || linkUrl) {
      formatted.setAttribute('href', linkUrl)
      formatted.setAttribute('target', '_blank')
      formatted.setAttribute('rel', 'noopener noreferrer')
      formatted.setAttribute('style', 'color:#2563eb;text-decoration:underline;font-weight:600')
    }
    fragment.append(formatted)
    const spaceNode = document.createTextNode(' ')
    fragment.append(spaceNode)
    if (after) fragment.append(document.createTextNode(after))
    const parent = textNode.parentNode
    if (!parent) return
    parent.replaceChild(fragment, textNode)
    setEditorCaret(spaceNode, 1)
    setEditContent(editor.innerHTML)
  }

  // 이미지 업로드는 현재 커서 위치에 이미지 요소로 직접 삽입한다.
  const insertImageFile = (file: File, altText: string) => {
    if (!file.type.startsWith('image/')) {
      alert('이미지 파일만 업로드할 수 있습니다.')
      return
    }
    const reader = new FileReader()
    reader.onload = event => {
      const dataUrl = event.target?.result as string
      const image = document.createElement('img')
      image.src = dataUrl
      image.alt = altText
      image.style.maxWidth = '100%'
      image.style.maxHeight = '450px'
      image.style.borderRadius = '12px'
      insertNodeAtEditorCursor(image)
    }
    reader.onerror = () => alert('이미지를 읽지 못했습니다.')
    reader.readAsDataURL(file)
  }

  const handleImageUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) insertImageFile(file, file.name)
    event.target.value = ''
  }

  const handlePaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    const imageItem = Array.from(event.clipboardData.items).find(item => item.type.startsWith('image/'))
    if (imageItem) {
      const file = imageItem.getAsFile()
      if (!file) return
      event.preventDefault()
      insertImageFile(file, '붙여넣은 이미지')
      return
    }
    // 외부 HTML이 에디터에 그대로 삽입되지 않도록 일반 텍스트만 붙여넣는다.
    event.preventDefault()
    insertPlainTextAtEditorCursor(event.clipboardData.getData('text/plain'))
  }

  const applyEditorCommand = (command: string) => {
    editorRef.current?.focus()
    document.execCommand(command, false)
    updateEditorContent()
  }

  // 모달창 엔터 키 핸들러
  const handleModalKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleProceedToEdit()
    }
  }

  // 작성/수정 페이지 단축키 (Ctrl + Enter) 핸들러
  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.defaultPrevented) return
    if (e.ctrlKey && e.key === 'Enter') {
      e.preventDefault()
      handleSaveEdit()
    }
  }

  const normalizedSearch = searchQuery.trim().toLocaleLowerCase()
  const filteredTerms = normalizedSearch
    ? allTerms.filter(term => {
        const searchable = [term.title, term.slug, term.category || '', ...parseTags(term.tags)]
          .join(' ')
          .toLocaleLowerCase()
        return searchable.includes(normalizedSearch)
      })
    : []

  const categories = [...new Set(allTerms.map(term => (term.category || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'))
  const activeGraphSlug = currentView === 'edit' ? editSlug : selectedTerm?.slug || ''
  const activeGraphLinks = currentView === 'edit'
    ? editLinkedSlugs
    : allTerms.find(term => term.slug === activeGraphSlug)?.linked_slugs || []
  const graphDisplayNodes = (currentView === 'detail' || currentView === 'edit') && activeGraphSlug
    ? nodes.filter(node => node.slug === activeGraphSlug || activeGraphLinks.includes(node.slug))
    : nodes
  const graphCategories = [...new Set(graphDisplayNodes.map(node => (node.category || '').trim()))].sort((a, b) => a.localeCompare(b, 'ko'))
  const normalizedListSearch = listSearchQuery.trim().toLocaleLowerCase()
  const filteredListTerms = allTerms.filter(term => {
    const categoryMatches = categoryFilter === 'all' || (categoryFilter === '__uncategorized__' ? !(term.category || '').trim() : (term.category || '').trim() === categoryFilter)
    const searchable = [term.title, term.slug, term.category || '', ...parseTags(term.tags)]
      .join(' ')
      .toLocaleLowerCase()
    return categoryMatches && (!normalizedListSearch || searchable.includes(normalizedListSearch))
  })

  const filterNodeOptions = (query: string, excludeSlug = '') => {
    const normalized = query.trim().toLocaleLowerCase()
    return allTerms.filter(term => {
      if (term.slug === excludeSlug) return false
      if (!normalized) return true
      return `${term.title} ${term.slug} ${term.category || ''} ${parseTags(term.tags).join(' ')}`.toLocaleLowerCase().includes(normalized)
    })
  }

  return (
    <div className="flex flex-col w-screen h-screen bg-slate-100 font-sans overflow-hidden">
      {/* 상단 네비게이션바 */}
      <header className="flex justify-between items-center px-8 py-4 bg-white border-b border-slate-200 shadow-sm shrink-0">
        <h1 
          onClick={() => { setCurrentView('home'); setSearchQuery(''); }} 
          className="text-xl font-extrabold text-blue-600 cursor-pointer"
        >
          IoT Glossary
        </h1>
        <div className="flex items-center gap-4">
          <button
            onClick={() => { setCurrentView('list'); setSearchQuery(''); }}
            className="text-sm font-bold text-slate-600 hover:text-blue-600 transition"
          >
            모든 문서 보기
          </button>
          <button
            onClick={openCreateModal}
            className="bg-blue-600 text-white px-4 py-2 rounded-xl text-sm font-bold shadow-md hover:bg-blue-700 transition"
          >
            새 문서 생성
          </button>
        </div>
      </header>

      {/* 메인 콘텐츠 영역 */}
      <main className="flex-1 overflow-y-auto p-8 relative flex items-start justify-center">
        {currentView === 'home' && (
          <div className="w-full max-w-xl flex flex-col items-center justify-center gap-6 text-center relative mt-20">
            <div className="flex flex-col gap-2">
              <h2 className="text-3xl font-black text-slate-800">IoT 지식 용어 사전</h2>
              <p className="text-sm text-slate-500">원하는 문서의 제목을 검색해 보세요.</p>
            </div>
            
            <div className="w-full relative">
              <input
                type="text"
                placeholder="검색할 문서 제목을 입력하세요..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-white border border-slate-400 rounded-xl px-4 py-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />

              {filteredTerms.length > 0 && (
                <div className="absolute left-0 right-0 top-full mt-2 bg-white border border-slate-300 rounded-xl shadow-xl max-h-60 overflow-y-auto z-20 text-left">
                  {filteredTerms.map((term) => (
                    <div
                      key={term.slug}
                      onClick={() => fetchTermDetail(term.slug)}
                      className="p-3 hover:bg-blue-50 cursor-pointer border-b border-slate-100 last:border-none transition flex justify-between items-center"
                    >
                      <div className="min-w-0">
                        <span className="block font-bold text-slate-800 text-sm">{term.title}</span>
                        {(term.category || parseTags(term.tags).length > 0) && (
                          <span className="block text-[11px] text-slate-400 truncate">{[term.category, ...parseTags(term.tags).map(tag => `#${tag}`)].filter(Boolean).join(' · ')}</span>
                        )}
                      </div>
                      <span className="text-xs text-slate-400 font-mono shrink-0">{term.slug}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 아래 최근 방문 페이지 4개 목록 영역 */}
            <div className="w-full flex flex-col gap-3 text-left mt-2">
              <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">최근 방문 페이지</span>
              <div className="grid grid-cols-2 gap-3">
                {recentSlugs.map((slug) => {
                  const term = allTerms.find(t => t.slug === slug)
                  if (!term) return null
                  return (
                    <div
                      key={slug}
                      onClick={() => fetchTermDetail(slug)}
                      className="p-3 bg-white border border-slate-300 rounded-xl hover:bg-blue-50 cursor-pointer transition flex justify-between items-center shadow-sm"
                    >
                      <div className="min-w-0">
                        <span className="block font-bold text-slate-800 text-sm truncate">{term.title}</span>
                        <span className="block text-[11px] text-slate-400 truncate">{term.category || '카테고리 없음'}</span>
                      </div>
                      <span className="text-xs text-blue-600 font-bold shrink-0 ml-2">열기 &rarr;</span>
                    </div>
                  )
                })}
              </div>
              {recentSlugs.length === 0 && (
                <div className="p-4 bg-white border border-slate-300 rounded-xl text-center text-xs text-slate-400 italic shadow-sm">
                  최근 방문한 페이지가 없습니다.
                </div>
              )}
            </div>
          </div>
        )}

        {currentView === 'list' && (
          <div className="w-full max-w-7xl flex gap-8 items-start justify-center">
            {/* 모든 문서 목록 박스 */}
            <div className="flex-1 bg-white p-8 rounded-2xl shadow-sm border border-slate-200 flex flex-col min-h-[750px]">
              <div className="flex justify-between items-center border-b pb-4 mb-6">
                <h2 className="text-2xl font-black text-slate-800">전체 문서 목록</h2>
                <button
                  onClick={() => setCurrentView('home')}
                  className="text-sm bg-slate-100 text-slate-700 font-bold px-4 py-2 rounded-xl hover:bg-slate-200 transition"
                >
                  홈으로 돌아가기
                </button>
              </div>
              <div className="mb-4 grid grid-cols-1 md:grid-cols-[1fr_220px] gap-3">
                <input
                  value={listSearchQuery}
                  onChange={(e) => setListSearchQuery(e.target.value)}
                  placeholder="제목, 태그, 카테고리 검색..."
                  className="w-full bg-white border border-slate-300 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <select
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value)}
                  className="w-full bg-white border border-slate-300 rounded-xl px-3 py-2.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="all">모든 카테고리</option>
                  <option value="__uncategorized__">카테고리 없음</option>
                  {categories.map(category => <option key={category} value={category}>{category}</option>)}
                </select>
              </div>
              <div className="flex items-center justify-between mb-3 text-xs text-slate-400">
                <span>총 {filteredListTerms.length}개 문서</span>
                {(categoryFilter !== 'all' || listSearchQuery) && (
                  <button onClick={() => { setCategoryFilter('all'); setListSearchQuery('') }} className="font-semibold text-blue-600 hover:underline">필터 초기화</button>
                )}
              </div>
              <div className="flex flex-col gap-3">
                {filteredListTerms.map((term) => (
                  <div
                    key={term.id || term.slug}
                    onClick={() => fetchTermDetail(term.slug)}
                    className="p-4 bg-slate-50 hover:bg-blue-50 border border-slate-300 rounded-xl cursor-pointer transition flex justify-between items-center gap-4"
                  >
                    <div className="min-w-0">
                      <h3 className="font-bold text-slate-800 text-lg truncate">{term.title}</h3>
                      <span className="text-xs text-slate-400 font-mono">slug: {term.slug}</span>
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {term.category && <span className="text-[11px] bg-blue-100 text-blue-700 px-2 py-0.5 rounded-md">{term.category}</span>}
                        {parseTags(term.tags).map(tag => <span key={tag} className="text-[11px] bg-slate-200 text-slate-600 px-2 py-0.5 rounded-md">#{tag}</span>)}
                      </div>
                    </div>
                    <span className="text-xs text-blue-600 font-bold shrink-0">읽기 &rarr;</span>
                  </div>
                ))}
                {filteredListTerms.length === 0 && (
                  <p className="text-center text-slate-400 py-8">조건에 맞는 문서가 없습니다.</p>
                )}
              </div>
            </div>

            {/* 우측 그래프뷰 (sticky top-8 적용하여 스크롤 시 화면 고정) */}
            <div className="w-[372px] bg-white p-4 rounded-2xl shadow-sm border border-slate-200 flex flex-col items-center sticky top-8">
              <span className="text-xs font-bold text-slate-400 mb-2">그래프뷰</span>
              <div className="bg-slate-50 rounded-xl overflow-hidden border border-slate-100 cursor-grab active:cursor-grabbing">
                <svg ref={minimapRef} width="340" height="340" className="w-[340px] h-[340px]"></svg>
                <div className="w-full max-h-20 overflow-y-auto flex flex-wrap gap-x-3 gap-y-1 px-1 pt-2">
                  {graphCategories.slice(0, 12).map(category => (
                    <span key={category || '__uncategorized__'} className="inline-flex items-center gap-1 text-[10px] text-slate-500">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: getCategoryColor(category) }} />
                      {category || '카테고리 없음'}
                    </span>
                  ))}
                  {graphCategories.length > 12 && <span className="text-[10px] text-slate-400">외 {graphCategories.length - 12}개</span>}
                </div>
              </div>
            </div>
          </div>
        )}

        {(currentView === 'detail' || currentView === 'edit') && (
          <div className="w-full max-w-7xl flex gap-8 items-start justify-center">
            {/* 메인 컨텐츠 박스 */}
            <div className="flex-1 bg-white p-8 rounded-2xl shadow-sm border border-slate-200 flex flex-col min-h-[750px]">
              {currentView === 'detail' && selectedTerm && (
                <div className="flex flex-col gap-6">
                  <div className="border-b border-slate-100 pb-4 flex justify-between items-center">
                    <div>
                      <h3 className="text-3xl font-black text-slate-900 mb-1">{selectedTerm.title}</h3>
                      <div className="flex gap-2 items-center">
                        <span className="text-xs bg-slate-100 text-slate-500 font-mono px-2.5 py-1 rounded-md">
                          slug: {selectedTerm.slug}
                        </span>
                        {(selectedTerm.linked_slugs || []).length > 0 && <span className="text-xs bg-blue-50 text-blue-600 px-2.5 py-1 rounded-md">연결된 노드 {selectedTerm.linked_slugs?.length}개</span>}
                        {selectedTerm.category && <span className="text-xs bg-indigo-50 text-indigo-700 px-2.5 py-1 rounded-md">{selectedTerm.category}</span>}
                      </div>
                      {parseTags(selectedTerm.tags).length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mt-2">
                          {parseTags(selectedTerm.tags).map(tag => <span key={tag} className="text-xs bg-slate-100 text-slate-600 px-2 py-1 rounded-md">#{tag}</span>)}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={openEditView}
                        className="text-sm bg-amber-50 text-amber-700 font-bold px-3 py-2 rounded-xl hover:bg-amber-100 transition border border-amber-200"
                      >
                        수정
                      </button>
                      <button
                        onClick={() => handleDelete(selectedTerm.slug)}
                        className="text-sm bg-rose-50 text-rose-700 font-bold px-3 py-2 rounded-xl hover:bg-rose-100 transition border border-rose-200"
                      >
                        삭제
                      </button>
                      <button
                        onClick={() => setCurrentView('home')}
                        className="text-sm bg-slate-100 text-slate-700 font-bold px-4 py-2 rounded-xl hover:bg-slate-200 transition"
                      >
                        홈으로
                      </button>
                    </div>
                  </div>
                  <div 
                    className="prose max-w-none text-slate-700 min-h-[400px] leading-relaxed text-base"
                    dangerouslySetInnerHTML={{ __html: renderDocumentHtml(selectedTerm.content || '') }}
                  />
                  <div className="text-xs text-slate-400 border-t border-slate-100 pt-4 flex justify-end">
                    <span className="font-mono">최종 수정일: {selectedTerm.updated_at}</span>
                  </div>
                </div>
              )}

              {currentView === 'edit' && (
                <div className="flex flex-col flex-1 gap-6" onKeyDown={handleEditKeyDown}>
                  <div className="border-b border-slate-100 pb-4 flex justify-between items-center">
                    <div className="flex items-center gap-4">
                      <div>
                        <h3 className="text-xl font-black text-slate-800">{editTitle}</h3>
                        <span className="text-xs text-slate-400">
                          {editLinkedSlugs.length ? `연결된 노드 ${editLinkedSlugs.length}개` : '연결된 노드 없음'}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setTempTitle(editTitle)
                          setTempLinkedSlugs(editLinkedSlugs)
                          setTempCategory(editCategory)
                          setTempTagsText(editTagsText)
                          setMetaLinkSearch('')
                          setIsMetaModalOpen(true)
                        }}
                        className="text-xs bg-slate-100 text-slate-700 font-bold px-3 py-1.5 rounded-xl hover:bg-slate-200 transition border border-slate-200"
                      >
                        설정 변경
                      </button>
                    </div>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={handleCancelEdit}
                        className="bg-slate-200 text-slate-700 px-4 py-2 rounded-xl text-sm font-bold hover:bg-slate-300 transition"
                      >
                        취소
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSaveEdit()}
                        className="bg-emerald-600 text-white px-5 py-2 rounded-xl text-sm font-bold shadow-md hover:bg-emerald-700 transition"
                      >
                        저장하기
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-col flex-1 gap-2">
                    <div className="flex justify-between items-center">
                      <label className="block text-xs font-bold text-slate-500 uppercase">본문 내용</label>
                      <input
                        type="file"
                        ref={fileInputRef}
                        accept="image/*"
                        onChange={handleImageUpload}
                        className="hidden"
                      />
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="text-xs bg-blue-50 text-blue-600 font-bold px-3 py-1 rounded-lg hover:bg-blue-100 transition border border-blue-200"
                      >
                        이미지 파일 업로드
                      </button>
                    </div>
                    <div className="flex flex-wrap items-center gap-1 border border-slate-200 rounded-t-xl bg-slate-50 px-2 py-2">
                      <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => applyEditorCommand('bold')} className="px-2.5 py-1 rounded-md text-sm font-bold hover:bg-slate-200" title="굵게">B</button>
                      <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => applyEditorCommand('italic')} className="px-2.5 py-1 rounded-md text-sm italic hover:bg-slate-200" title="기울임">I</button>
                      <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => applyEditorCommand('strikeThrough')} className="px-2.5 py-1 rounded-md text-sm line-through hover:bg-slate-200" title="취소선">S</button>
                      <span className="mx-1 h-5 border-l border-slate-300" />
                      <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => applyEditorCommand('insertUnorderedList')} className="px-2.5 py-1 rounded-md text-xs hover:bg-slate-200" title="글머리 기호">목록</button>
                      <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => applyEditorCommand('insertOrderedList')} className="px-2.5 py-1 rounded-md text-xs hover:bg-slate-200" title="번호 목록">번호</button>
                      <span className="ml-auto text-[11px] text-slate-400">입력 중 서식 적용 · Jira 이슈 키 자동 링크</span>
                    </div>
                    <div
                      ref={editorRef}
                      contentEditable
                      suppressContentEditableWarning
                      onInput={updateEditorContent}
                      onKeyDown={handleEditorKeyDown}
                      onKeyUp={rememberEditorSelection}
                      onMouseUp={rememberEditorSelection}
                      onFocus={rememberEditorSelection}
                      onPaste={handlePaste}
                      className="prose prose-sm max-w-none w-full flex-1 min-h-[550px] overflow-y-auto bg-white border border-slate-300 border-t-0 rounded-b-xl p-4 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* 우측 그래프뷰 영역 (sticky top-8 적용하여 스크롤 시 화면 고정) */}
            <div className="w-[372px] bg-white p-4 rounded-2xl shadow-sm border border-slate-200 flex flex-col items-center sticky top-8">
              <span className="text-xs font-bold text-slate-400 mb-2">그래프뷰</span>
              <div className="bg-slate-50 rounded-xl overflow-hidden border border-slate-100 cursor-grab active:cursor-grabbing">
                <svg ref={minimapRef} width="340" height="340" className="w-[340px] h-[340px]"></svg>
                <div className="w-full max-h-20 overflow-y-auto flex flex-wrap gap-x-3 gap-y-1 px-1 pt-2">
                  {graphCategories.slice(0, 12).map(category => (
                    <span key={category || '__uncategorized__'} className="inline-flex items-center gap-1 text-[10px] text-slate-500">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: getCategoryColor(category) }} />
                      {category || '카테고리 없음'}
                    </span>
                  ))}
                  {graphCategories.length > 12 && <span className="text-[10px] text-slate-400">외 {graphCategories.length - 12}개</span>}
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* 새 문서 생성 모달 창 */}
      {isModalOpen && (
        <div 
          className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4"
          onKeyDown={handleModalKeyDown}
        >
          <div className="bg-white w-full max-w-md p-6 rounded-2xl shadow-2xl border border-slate-200 flex flex-col gap-4 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center border-b pb-3">
              <h3 className="text-lg font-bold text-slate-800">새 문서 및 노드 연결</h3>
              <button
                onClick={() => setIsModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 font-bold text-lg"
              >
                &times;
              </button>
            </div>
            <div className="flex flex-col gap-4">
              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">문서 제목</label>
                <input
                  type="text"
                  placeholder="문서 제목을 입력하세요"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl p-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  autoFocus
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">카테고리</label>
                <input
                  list="create-category-options"
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                  placeholder="예: 네트워크, 보안, 하드웨어"
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl p-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <datalist id="create-category-options">
                  {categories.map(category => <option key={category} value={category} />)}
                </datalist>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">태그</label>
                <input
                  value={newTagsText}
                  onChange={(e) => setNewTagsText(e.target.value)}
                  placeholder="쉼표로 구분해 입력 (예: TCP, 프로토콜, 통신)"
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl p-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p className="mt-1 text-[11px] text-slate-400">태그는 쉼표(,)로 구분해 입력하면 돼.</p>
              </div>

              {/* 링크드 노드 연결 */}
              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">연결할 링크드 노드 (복수 선택)</label>
                <div className="bg-slate-50 border border-slate-300 rounded-xl p-3 flex flex-col gap-2">
                  <input value={createLinkSearch} onChange={e => setCreateLinkSearch(e.target.value)} placeholder="제목, 카테고리, 태그로 노드 검색..." className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  <div className="max-h-40 overflow-y-auto flex flex-col gap-2">
                    {filterNodeOptions(createLinkSearch).map(term => <label key={term.slug} className="flex items-start gap-2 text-sm text-slate-700 cursor-pointer">
                      <input type="checkbox" checked={selectedLinkedSlugs.includes(term.slug)} onChange={e => setSelectedLinkedSlugs(prev => e.target.checked ? [...prev, term.slug] : prev.filter(slug => slug !== term.slug))} className="mt-0.5 rounded border-slate-300 text-blue-600" />
                      <span className="min-w-0"><span className="block">{term.title}</span><span className="block text-[11px] text-slate-400">{term.category || '카테고리 없음'} · {parseTags(term.tags).map(tag => `#${tag}`).join(' ') || '태그 없음'}</span></span>
                    </label>)}
                    {filterNodeOptions(createLinkSearch).length === 0 && <span className="text-xs text-slate-400">검색 결과가 없습니다.</span>}
                  </div>
                  <p className="text-[11px] text-slate-400">선택된 링크: {selectedLinkedSlugs.length}개 · 모든 노드는 대등하게 양방향으로 연결됩니다.</p>
                </div>
              </div>

              <div className="flex justify-end gap-2 mt-4 pt-3 border-t">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="bg-slate-200 text-slate-700 px-5 py-2.5 rounded-xl text-sm font-bold hover:bg-slate-300 transition"
                >
                  취소
                </button>
                <button
                  type="button"
                  onClick={() => handleProceedToEdit()}
                  className="bg-blue-600 text-white px-5 py-2.5 rounded-xl text-sm font-bold shadow-md hover:bg-blue-700 transition"
                >
                  내용 작성하기
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 문서 메타데이터 및 링크드 노드 설정 모달 */}
      {isMetaModalOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white w-full max-w-md p-6 rounded-2xl shadow-2xl border border-slate-200 flex flex-col gap-4 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center border-b pb-3">
              <h3 className="text-lg font-bold text-slate-800">문서 설정 변경</h3>
              <button
                onClick={() => setIsMetaModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 font-bold text-lg"
              >
                &times;
              </button>
            </div>
            <div className="flex flex-col gap-4">
              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">문서 제목</label>
                <input
                  type="text"
                  value={tempTitle}
                  onChange={(e) => setTempTitle(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl p-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">카테고리</label>
                <input
                  list="meta-category-options"
                  value={tempCategory}
                  onChange={(e) => setTempCategory(e.target.value)}
                  placeholder="카테고리 입력"
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl p-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <datalist id="meta-category-options">
                  {categories.map(category => <option key={category} value={category} />)}
                </datalist>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">태그</label>
                <input
                  value={tempTagsText}
                  onChange={(e) => setTempTagsText(e.target.value)}
                  placeholder="쉼표로 구분해 입력 (예: TCP, 프로토콜)"
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl p-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              {/* 링크드 노드 연결 */}
              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">연결된 링크드 노드 (복수 선택)</label>
                <div className="bg-slate-50 border border-slate-300 rounded-xl p-3 flex flex-col gap-2">
                  <input value={metaLinkSearch} onChange={e => setMetaLinkSearch(e.target.value)} placeholder="제목, 카테고리, 태그로 노드 검색..." className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  <div className="max-h-40 overflow-y-auto flex flex-col gap-2">
                    {filterNodeOptions(metaLinkSearch, editSlug).map(term => <label key={term.slug} className="flex items-start gap-2 text-sm text-slate-700 cursor-pointer">
                      <input type="checkbox" checked={tempLinkedSlugs.includes(term.slug)} onChange={e => setTempLinkedSlugs(prev => e.target.checked ? [...prev, term.slug] : prev.filter(slug => slug !== term.slug))} className="mt-0.5 rounded border-slate-300 text-blue-600" />
                      <span className="min-w-0"><span className="block">{term.title}</span><span className="block text-[11px] text-slate-400">{term.category || '카테고리 없음'} · {parseTags(term.tags).map(tag => `#${tag}`).join(' ') || '태그 없음'}</span></span>
                    </label>)}
                    {filterNodeOptions(metaLinkSearch, editSlug).length === 0 && <span className="text-xs text-slate-400">검색 결과가 없습니다.</span>}
                  </div>
                  <p className="text-[11px] text-slate-400">선택된 링크: {tempLinkedSlugs.length}개 · 모든 노드는 대등하게 양방향으로 연결됩니다.</p>
                </div>
              </div>

              <div className="flex justify-end gap-2 mt-4 pt-3 border-t">
                <button
                  type="button"
                  onClick={() => setIsMetaModalOpen(false)}
                  className="bg-slate-200 text-slate-700 px-5 py-2.5 rounded-xl text-sm font-bold hover:bg-slate-300 transition"
                >
                  취소
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    if (!tempTitle.trim()) {
                      alert("제목을 입력해주세요.")
                      return
                    }
                    setEditTitle(tempTitle)
                    setEditLinkedSlugs(tempLinkedSlugs)
                    setEditCategory(tempCategory)
                    setEditTagsText(tempTagsText)
                    const term = allTerms.find(item => item.slug === editSlug)
                    if (term) {
                      const saveRes = await fetch(`${API_BASE_URL}/api/terms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: editSlug, title: tempTitle, content: editContent, category: tempCategory.trim() || null, tags: parseTags(tempTagsText), linked_slugs: tempLinkedSlugs }) })
                      if (!saveRes.ok) { alert('설정을 저장하지 못했습니다.'); return }
                    }
                    await fetchData()
                    setIsMetaModalOpen(false)
                  }}
                  className="bg-blue-600 text-white px-5 py-2.5 rounded-xl text-sm font-bold shadow-md hover:bg-blue-700 transition"
                >
                  적용하기
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {deleteTargetSlug && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[70] p-4" role="presentation">
          <div className="bg-white w-full max-w-sm rounded-2xl shadow-2xl border border-slate-200 p-6 flex flex-col gap-4" role="dialog" aria-modal="true" aria-labelledby="delete-dialog-title">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-rose-100 text-rose-600 flex items-center justify-center shrink-0">
                <span className="text-lg font-bold">!</span>
              </div>
              <div className="min-w-0">
                <h3 id="delete-dialog-title" className="text-lg font-bold text-slate-900">문서를 삭제할까요?</h3>
                <p className="mt-1 text-sm text-slate-500">삭제한 문서는 복구할 수 없습니다.</p>
                <p className="mt-2 text-xs font-mono text-slate-400 break-all">{deleteTargetSlug}</p>
              </div>
            </div>
            {deleteError && <p className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-lg p-3">{deleteError}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={isDeleting}
                onClick={() => { setDeleteTargetSlug(null); setDeleteError('') }}
                className="px-4 py-2 rounded-xl text-sm font-bold bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-50"
              >취소</button>
              <button
                type="button"
                disabled={isDeleting}
                onClick={confirmDelete}
                className="px-4 py-2 rounded-xl text-sm font-bold bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-50"
              >{isDeleting ? '삭제 중...' : '삭제하기'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}