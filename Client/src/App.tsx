import React, { useEffect, useRef, useState } from 'react'
import * as d3 from 'd3'

interface Node {
  id: number
  slug: string
  title: string
  parent_slug?: string | null
  category?: string
  tags?: string[]
  linked_slugs?: string[]
  radius?: number
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

// 상시 가동 중인 Cloudflare Worker 백엔드 주소
const API_BASE_URL = 'https://iot-glossary.smh13918957.workers.dev'

export default function App() {
  const minimapRef = useRef<SVGSVGElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const editorRef = useRef<HTMLDivElement | null>(null)

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

  const getNodeRadius = (_node: Node, _currentLinks: Link[] = []) => NODE_RADIUS

  // 데이터 로드 및 반지름 동기화
  const fetchData = async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/terms`)
      if (!res.ok) throw new Error(`용어 목록을 불러오지 못했습니다. (${res.status})`)
      const data = await res.json()
      if (data && data.nodes) {
        const rawNodes: Node[] = data.nodes
        const rawLinks: Link[] = data.links || []
        const processedNodes = rawNodes.map(node => ({
          ...node,
          radius: getNodeRadius(node, rawLinks)
        }))
        setNodes(processedNodes)
        setLinks(rawLinks)
        setAllTerms((data.terms || processedNodes).map(normalizeTerm))
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

  // 에디터 진입 시 초기 내용 반영 및 자동 포커스
  useEffect(() => {
    if (currentView === 'edit' && editorRef.current) {
      editorRef.current.innerHTML = editContent
      editorRef.current.focus()
    }
  }, [currentView])

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

  // 노드 컬러 계산 (최상위 노드만 고유 HSL 컬러 지정)
  const getNodeColor = (_node: Node, activeSlug: string) => {
    if (node.slug === activeSlug) return '#1d4ed8'
    
    return '#2563eb'
  }

  // 그래프 뷰 D3 렌더링
  useEffect(() => {
    if (!minimapRef.current) return

    const svg = d3.select(minimapRef.current)
    svg.selectAll("*").remove()

    if (currentView === 'home') {
      return
    }

    const width = 340
    const height = 340

    const container = svg.append("g")

    const zoom = d3.zoom()
      .scaleExtent([0.1, 4])
      .on("zoom", (event) => {
        container.attr("transform", event.transform)
      })

    svg.call(zoom as any)

    const activeSlug = selectedTerm?.slug || editSlug
    let relevantNodes = nodes
    let relevantLinks = links

    if (currentView === 'detail' || currentView === 'edit') {
      const currentNode = nodes.find(n => n.slug === activeSlug)
      const linkedSlugs = new Set(editSlug === activeSlug && currentView === 'edit' ? editLinkedSlugs : (allTerms.find(t => t.slug === activeSlug)?.linked_slugs || []))
      relevantNodes = nodes.filter(n => !currentNode || n.slug === currentNode.slug || linkedSlugs.has(n.slug))

      const relevantNodeIds = new Set(relevantNodes.map(n => n.id))
      relevantLinks = links.filter(l => {
        const sourceId = typeof l.source === 'object' ? (l.source as any).id : l.source
        const targetId = typeof l.target === 'object' ? (l.target as any).id : l.target
        return relevantNodeIds.has(sourceId) && relevantNodeIds.has(targetId)
      })
    }

    if (relevantNodes.length === 0) return

    // 물리 시뮬레이션 설정 (링크 엉킴 방지)
    const simulation = d3.forceSimulation(relevantNodes as d3.SimulationNodeDatum[])
      .alphaDecay(0.06)
      .velocityDecay(0.3)
      .force("link", d3.forceLink(relevantLinks).id((d: any) => d.id).distance(110))
      .force("charge", d3.forceManyBody().strength(-220))
      .force("x", d3.forceX(width / 2).strength(0.05))
      .force("y", d3.forceY(height / 2).strength(0.05))
      .force("collide", d3.forceCollide().radius((d: any) => getNodeRadius(d, links) + 22))

    // 1. 링크 레이어
    const link = container.append("g")
      .selectAll("line")
      .data(relevantLinks)
      .enter()
      .append("line")
      .attr("stroke", "#cbd5e1")
      .attr("stroke-width", 1.5)


    // 2. 노드 그룹 레이어
    const node = container.append("g")
      .selectAll("g")
      .data(relevantNodes)
      .enter()
      .append("g")
      .call(d3.drag<SVGGElement, any>()
        .on("start", (event, d) => {
          if (!event.active) simulation.alphaTarget(0.3).restart()
          d.fx = d.x
          d.fy = d.y
          d3.select(event.sourceEvent.target.closest('g') || event.sourceEvent.target.parentNode).raise()
        })
        .on("drag", (event, d) => {
          d.fx = event.x
          d.fy = event.y
        })
        .on("end", (event, d) => {
          if (!event.active) simulation.alphaTarget(0)
          d.fx = null
          d.fy = null
        })
      )

    node.append("circle")
      .attr("r", (d: any) => getNodeRadius(d, links))
      .attr("fill", (d: any) => getNodeColor(d, activeSlug))
      .attr("stroke", "#ffffff")
      .attr("stroke-width", 2)
      .attr("cursor", "grab")
      .on("mousedown", function() {
        d3.select(this.parentNode as any).raise()
      })
      .on("click", (event, d) => {
        event.stopPropagation()
        fetchTermDetail(d.slug)
      })

    // 3. 텍스트 레이어
    const textGroup = container.append("g")
    const textSelection = textGroup
      .selectAll("text")
      .data(relevantNodes)
      .enter()
      .append("text")
      .text((d: any) => d.title)
      .attr("x", (d: any) => getNodeRadius(d, links) + 4)
      .attr("y", 4)
      .attr("fill", "#1e293b")
      .attr("font-size", "11px")
      .attr("font-family", '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif')
      .attr("font-weight", 500)
      .attr("cursor", "pointer")
      .on("click", (event, d) => {
        event.stopPropagation()
        fetchTermDetail(d.slug)
      })

    const fitView = () => {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
      relevantNodes.forEach((d: any) => {
        if (d.x < x0) x0 = d.x
        if (d.x > x1) x1 = d.x
        if (d.y < y0) y0 = d.y
        if (d.y > y1) y1 = d.y
      })

      const boundsWidth = (x1 - x0) || 1
      const boundsHeight = (y1 - y0) || 1
      const scale = Math.min(1.2, Math.max(0.2, 0.8 / Math.max(boundsWidth / width, boundsHeight / height)))
      const midX = (x0 + x1) / 2
      const midY = (y0 + y1) / 2

      svg.call(
        zoom.transform as any,
        d3.zoomIdentity
          .translate(width / 2 - scale * midX, height / 2 - scale * midY)
          .scale(scale)
      )
    }

    simulation.on("tick", () => {
      link
        .attr("x1", (d: any) => d.source.x)
        .attr("y1", (d: any) => d.source.y)
        .attr("x2", (d: any) => d.target.x)
        .attr("y2", (d: any) => d.target.y)

      node
        .attr("transform", (d: any) => `translate(${d.x}, ${d.y})`)

      textSelection
        .attr("transform", (d: any) => `translate(${d.x}, ${d.y})`)
    })

    simulation.on("end", fitView)

  }, [nodes, links, currentView, selectedTerm, editSlug, editLinkedSlugs, allTerms])

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
          content: editContent,
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

  // 로컬 이미지 파일 업로드 핸들러
  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return

    const file = files[0]
    const reader = new FileReader()
    reader.onload = (event) => {
      const base64Str = event.target?.result as string
      const img = document.createElement('img')
      img.src = base64Str
      img.style.maxWidth = '100%'
      img.style.maxHeight = '450px'
      img.style.borderRadius = '12px'
      img.style.margin = '12px 0'

      const selection = window.getSelection()
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0)
        range.deleteContents()
        range.insertNode(img)
        range.collapse(false)
      } else if (editorRef.current) {
        editorRef.current.appendChild(img)
      }

      if (editorRef.current) {
        setEditContent(editorRef.current.innerHTML)
      }
    }
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  // 클립보드 이미지 붙여넣기 (Ctrl + V) 핸들러
  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const items = e.clipboardData.items
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        e.preventDefault()
        const file = items[i].getAsFile()
        if (!file) return
        const reader = new FileReader()
        reader.onload = (event) => {
          const base64Str = event.target?.result as string
          const img = document.createElement('img')
          img.src = base64Str
          img.style.maxWidth = '100%'
          img.style.maxHeight = '450px'
          img.style.borderRadius = '12px'
          img.style.margin = '12px 0'

          const selection = window.getSelection()
          if (selection && selection.rangeCount > 0) {
            const range = selection.getRangeAt(0)
            range.deleteContents()
            range.insertNode(img)
            range.collapse(false)
          } else if (editorRef.current) {
            editorRef.current.appendChild(img)
          }

          if (editorRef.current) {
            setEditContent(editorRef.current.innerHTML)
          }
        }
        reader.readAsDataURL(file)
      }
    }
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
                    dangerouslySetInnerHTML={{ __html: selectedTerm.content || '<span class="text-slate-400 italic">작성된 내용이 없습니다. 수정 버튼을 눌러 내용을 채워보세요.</span>' }}
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
                    <div
                      ref={editorRef}
                      contentEditable
                      suppressContentEditableWarning
                      onInput={(e) => setEditContent(e.currentTarget.innerHTML)}
                      onPaste={handlePaste}
                      className="w-full flex-1 bg-slate-50 border border-slate-300 rounded-xl p-4 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 font-sans leading-relaxed overflow-y-auto min-h-[550px]"
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
              <h3 className="text-lg font-bold text-slate-800">새 문서 기본 정보 입력</h3>
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
                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">연결할 노드 (복수 선택)</label>
                <div className="bg-slate-50 border border-slate-300 rounded-xl p-3 flex flex-col gap-2">
                  <input value={createLinkSearch} onChange={e => setCreateLinkSearch(e.target.value)} placeholder="제목, 카테고리, 태그로 노드 검색..." className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  <div className="max-h-40 overflow-y-auto flex flex-col gap-2">
                    {filterNodeOptions(createLinkSearch).map(term => <label key={term.slug} className="flex items-start gap-2 text-sm text-slate-700 cursor-pointer">
                      <input type="checkbox" checked={selectedLinkedSlugs.includes(term.slug)} onChange={e => setSelectedLinkedSlugs(prev => e.target.checked ? [...prev, term.slug] : prev.filter(slug => slug !== term.slug))} className="mt-0.5 rounded border-slate-300 text-blue-600" />
                      <span className="min-w-0"><span className="block">{term.title}</span><span className="block text-[11px] text-slate-400">{term.category || '카테고리 없음'} · {parseTags(term.tags).map(tag => `#${tag}`).join(' ') || '태그 없음'}</span></span>
                    </label>)}
                    {filterNodeOptions(createLinkSearch).length === 0 && <span className="text-xs text-slate-400">검색 결과가 없습니다.</span>}
                  </div>
                  <p className="text-[11px] text-slate-400">선택된 연결: {selectedLinkedSlugs.length}개 · 연결은 양방향으로 표시됩니다.</p>
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

      {/* 작성 페이지 내 제목/상위노드/하위노드 편집 모달 */}
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
                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">연결된 노드 (복수 선택)</label>
                <div className="bg-slate-50 border border-slate-300 rounded-xl p-3 flex flex-col gap-2">
                  <input value={metaLinkSearch} onChange={e => setMetaLinkSearch(e.target.value)} placeholder="제목, 카테고리, 태그로 노드 검색..." className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  <div className="max-h-40 overflow-y-auto flex flex-col gap-2">
                    {filterNodeOptions(metaLinkSearch, editSlug).map(term => <label key={term.slug} className="flex items-start gap-2 text-sm text-slate-700 cursor-pointer">
                      <input type="checkbox" checked={tempLinkedSlugs.includes(term.slug)} onChange={e => setTempLinkedSlugs(prev => e.target.checked ? [...prev, term.slug] : prev.filter(slug => slug !== term.slug))} className="mt-0.5 rounded border-slate-300 text-blue-600" />
                      <span className="min-w-0"><span className="block">{term.title}</span><span className="block text-[11px] text-slate-400">{term.category || '카테고리 없음'} · {parseTags(term.tags).map(tag => `#${tag}`).join(' ') || '태그 없음'}</span></span>
                    </label>)}
                    {filterNodeOptions(metaLinkSearch, editSlug).length === 0 && <span className="text-xs text-slate-400">검색 결과가 없습니다.</span>}
                  </div>
                  <p className="text-[11px] text-slate-400">선택된 연결: {tempLinkedSlugs.length}개 · 연결은 양방향으로 표시됩니다.</p>
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