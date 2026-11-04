import './style.css'
import { EditorView } from '@codemirror/view'
import {
  createEditor,
  getMarkdown,
  setMarkdown,
  countWords,
} from './editor.js'
import {
  createSourceEditor,
  setSourceDoc,
  getSourceDoc,
} from './source-mode.js'

// ---------- Wails 运行时绑定（wails dev / build 时由桥接注入） ----------
const wails = () => window.go?.main?.App

// ---------- DOM ----------
const $ = (id) => document.getElementById(id)
const elTitle = $('file-title')
const elModeBtn = $('btn-mode')
const elWords = $('status-words')
const elMode = $('status-mode')
const elDirty = $('status-dirty')
const elPath = $('status-path')
const elTiptapWrap = $('tiptap-editor')
const elCmWrap = $('codemirror-editor')

// ---------- 状态 ----------
let currentPath = '' // 显示用文件路径
let dirty = false
let mode = 'wysiwyg' // 'wysiwyg' | 'source'
let docOpen = false // 是否已进入编辑状态（新建/打开后为 true，启动页不再出现）
let loading = false // 程序性装载内容期间为 true（此时编辑器变更不算用户编辑）

function baseName(p) {
  if (!p) return '未命名'
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return i >= 0 ? p.slice(i + 1) : p
}

// 标题栏显示用文件名（隐藏 .md 扩展名）
function displayName(p) {
  return baseName(p).replace(/\.(md|markdown)$/i, '')
}

function dirName(p) {
  if (!p) return ''
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return i > 0 ? p.slice(0, i) : ''
}

function refreshHeader() {
  elTitle.textContent = displayName(currentPath) + (dirty ? ' ●' : '')
  elTitle.title = currentPath ? '点击重命名' : ''
  elDirty.textContent = dirty ? '未保存' : '已保存'
  // 状态栏显示文件所在目录；未命名/未保存时不显示
  const dir = dirName(currentPath)
  elPath.textContent = dir
  elPath.title = dir
}

// ---------- 标题栏点击重命名 ----------
let renaming = false

async function startRename() {
  if (renaming) return
  if (!currentPath) {
    elDirty.textContent = '请先保存文件后再重命名'
    return
  }
  renaming = true

  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'title-input'
  input.value = displayName(currentPath)
  elTitle.textContent = ''
  elTitle.appendChild(input)
  input.focus()
  input.select()

  let done = false
  const finish = async (commit) => {
    if (done) return
    done = true
    const val = input.value.trim()
    elTitle.textContent = ''
    renaming = false

    if (commit && val && val !== displayName(currentPath)) {
      const app = wails()
      if (app) {
        try {
          const newPath = await app.RenameFile(val)
          if (newPath) currentPath = newPath
        } catch (e) {
          alert('重命名失败: ' + e)
        }
      }
    }
    refreshHeader()
    if (!commit) editor.commands.focus()
  }

  input.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter') {
      e.preventDefault()
      finish(true)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      finish(false)
    }
  })
  input.addEventListener('blur', () => finish(true))
  // 点击输入框内不触发外层点击
  input.addEventListener('click', (e) => e.stopPropagation())
}

elTitle.addEventListener('click', startRename)

function refreshStats(md) {
  elWords.textContent = `${countWords(md)} 字`
}

function markDirty() {
  if (!dirty) {
    dirty = true
    refreshHeader()
  }
  scheduleAutoSave()
}

// ---------- 自动保存（防抖 2s，仅用于已命名的文件） ----------
let autoSaveTimer = null

function scheduleAutoSave() {
  clearTimeout(autoSaveTimer)
  autoSaveTimer = setTimeout(autoSave, 2000)
}

function nowTime() {
  return new Date().toTimeString().slice(0, 5)
}

async function autoSave() {
  const app = wails()
  if (!app) return
  if (!currentPath) return // 未命名文档不自动保存；关闭时询问「保留 / 废弃」
  try {
    await app.SaveMarkdown(currentMarkdown())
    dirty = false
    refreshHeader()
    elDirty.textContent = `已自动保存 ${nowTime()}`
  } catch (e) {
    console.error('自动保存失败', e)
  }
}

// ---------- 图片上传（落盘到 Go 端，按设置决定位置） ----------
async function uploadImage(file) {
  const app = wails()
  if (!app) return null
  const dataURL = await new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result)
    r.onerror = reject
    r.readAsDataURL(file)
  })
  return app.SaveImage(file.name, dataURL)
}

// ---------- Tiptap ----------
const editor = createEditor(elTiptapWrap, {
  onUpdate: (md) => {
    markDirty()
    refreshStats(md)
    refreshOutline()
  },
  getCurrentDir: () => dirName(currentPath),
  uploadImage,
  downloadImage: (url) => wails()?.DownloadImage(url),
  bubbleElement: $('bubble-menu'),
})

// ---------- 选中文字悬浮气泡 ----------
const bubbleEl = $('bubble-menu')
bubbleEl.querySelectorAll('button').forEach((btn) => {
  // mousedown 阻止焦点转移，保住选区
  btn.addEventListener('mousedown', (e) => e.preventDefault())
  btn.addEventListener('click', () => {
    const chain = editor.chain().focus()
    const cmd = btn.dataset.cmd
    if (cmd === 'bold') chain.toggleBold().run()
    else if (cmd === 'italic') chain.toggleItalic().run()
    else if (cmd === 'strike') chain.toggleStrike().run()
    else if (cmd === 'highlight') chain.toggleHighlight().run()
    else if (cmd === 'code') chain.toggleCode().run()
  })
})
// 按钮高亮状态跟随光标处格式
editor.on('transaction', () => {
  bubbleEl.querySelectorAll('button').forEach((btn) => {
    const cmd = btn.dataset.cmd
    const active =
      cmd === 'highlight' ? editor.isActive('highlight') : editor.isActive(cmd)
    btn.classList.toggle('is-active', active)
  })
})

// 滚动时隐藏气泡（wails 气泡只在新事务时重新评估，滚动不会触发，
// 不处理会滞留并错位；重新选中文本时它会自动再出现）
const hideBubbleOnScroll = () => {
  // 只改 visibility：气泡再次展示时 Tiptap 会把 visibility 设回 visible
  bubbleEl.style.visibility = 'hidden'
}
// 编辑区滚动容器（注意：$ 是 getElementById 的简写，此处须用 querySelector）
const editorScrollWrap = document.querySelector('.editor-wrap')
editorScrollWrap?.addEventListener('scroll', hideBubbleOnScroll, { passive: true })
window.addEventListener('wheel', hideBubbleOnScroll, { passive: true })

// ---------- CodeMirror ----------
const cm = createSourceEditor(elCmWrap, {
  onChange: (text) => {
    if (loading) return // 打开/装载文件时的程序性变更，不是用户编辑
    setMarkdown(editor, text) // 实时同步进 tiptap（不触发其 onUpdate）
    markDirty()
    refreshStats(text)
    refreshOutline()
  },
  onSave: () => saveDocument(),
})

// ---------- 模式切换 ----------
function setMode(next) {
  if (next === mode) return
  mode = next
  if (mode === 'source') {
    loading = true
    setSourceDoc(cm, getMarkdown(editor)) // 程序性装载，不标脏
    loading = false
    elTiptapWrap.classList.add('hidden')
    elCmWrap.classList.remove('hidden')
    elModeBtn.textContent = '所见即所得'
    elMode.textContent = '源码模式'
    cm.focus()
  } else {
    // CodeMirror onChange 已实时同步进 tiptap，直接切回
    elCmWrap.classList.add('hidden')
    elTiptapWrap.classList.remove('hidden')
    elModeBtn.textContent = '源码模式'
    elMode.textContent = '所见即所得'
    editor.commands.focus()
  }
}

elModeBtn.addEventListener('click', () =>
  setMode(mode === 'wysiwyg' ? 'source' : 'wysiwyg'),
)

// ---------- 表格：标题栏插入 + 表格内右键菜单 ----------
$('tb-insert').addEventListener('click', () => {
  editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
})

// ---------- 插入链接：[链接名称](链接地址) ----------
const linkOverlay = $('link-overlay')
const linkTextInput = $('link-text')
const linkUrlInput = $('link-url')
let linkRange = null // 打开弹窗时的选区（弹窗期间编辑器会失焦）

function openLinkDialog() {
  const { from, to } = editor.state.selection
  const selected = from !== to ? editor.state.doc.textBetween(from, to, ' ') : ''
  linkRange = { from, to }
  linkTextInput.value = selected
  linkUrlInput.value = ''
  linkOverlay.classList.remove('hidden')
  // 已有选中文字时名称已填好，直接输入地址
  ;(selected ? linkUrlInput : linkTextInput).focus()
}

function closeLinkDialog() {
  linkOverlay.classList.add('hidden')
  linkTextInput.value = ''
  linkUrlInput.value = ''
  linkRange = null
}

function insertLink() {
  const url = linkUrlInput.value.trim()
  if (!url) {
    linkUrlInput.focus()
    return
  }
  // 名称为空时用地址代替
  const text = linkTextInput.value.trim() || url
  const sel = linkRange
  closeLinkDialog()
  const chain = editor.chain().focus()
  if (sel) chain.setTextSelection(sel)
  // 有选区时替换选中内容；无选区时插入到光标处
  chain
    .insertContent({
      type: 'text',
      text,
      marks: [{ type: 'link', attrs: { href: url } }],
    })
    .run()
  editor.commands.focus()
}

$('tb-link').addEventListener('click', openLinkDialog)
$('btn-link-cancel').addEventListener('click', closeLinkDialog)
$('btn-link-ok').addEventListener('click', insertLink)
for (const input of [linkTextInput, linkUrlInput]) {
  input.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter') {
      e.preventDefault()
      insertLink()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closeLinkDialog()
    }
  })
}
// 模态：点遮罩不关闭，Esc 关闭（避免误操作背后内容）
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !linkOverlay.classList.contains('hidden')) closeLinkDialog()
})

// 判断文档坐标 pos 是否位于表格内
function posInsideTable(pos) {
  const $pos = editor.state.doc.resolve(pos)
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.name === 'table') return true
  }
  return false
}

// 构建右键菜单项（光标已在表格内）
function tableMenuItems() {
  const chain = () => editor.chain().focus()
  return [
    { label: '上方插入行', run: () => chain().addRowBefore().run() },
    { label: '下方插入行', run: () => chain().addRowAfter().run() },
    { label: '删除行', run: () => chain().deleteRow().run() },
    { sep: true },
    { label: '左侧插入列', run: () => chain().addColumnBefore().run() },
    { label: '右侧插入列', run: () => chain().addColumnAfter().run() },
    { label: '删除列', run: () => chain().deleteColumn().run() },
    { sep: true },
    { label: '删除表格', danger: true, run: () => chain().deleteTable().run() },
  ]
}

// 右键菜单 DOM（懒创建）
const ctxMenu = document.createElement('div')
ctxMenu.className = 'ctx-menu hidden'
document.body.appendChild(ctxMenu)

function hideCtxMenu() {
  ctxMenu.classList.add('hidden')
}

// 通用右键菜单：items = [{label, run, danger} | {sep}]
function showMenu(x, y, items) {
  ctxMenu.innerHTML = ''
  for (const item of items) {
    if (item.sep) {
      const sep = document.createElement('div')
      sep.className = 'ctx-sep'
      ctxMenu.appendChild(sep)
      continue
    }
    const btn = document.createElement('button')
    btn.textContent = item.label
    if (item.danger) btn.classList.add('danger')
    btn.addEventListener('click', () => {
      hideCtxMenu()
      item.run()
    })
    ctxMenu.appendChild(btn)
  }
  ctxMenu.classList.remove('hidden')
  // 边界处理：不让菜单超出窗口
  const rect = ctxMenu.getBoundingClientRect()
  ctxMenu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px'
  ctxMenu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px'
}

// 从 DOM img 元素反解磁盘绝对路径；非本地图片返回 null
function imageDiskPath(img) {
  const src = img.getAttribute('src') || ''
  if (src.startsWith('/local-file?path=')) {
    try {
      return new URL(src, location.origin).searchParams.get('path')
    } catch {
      return null
    }
  }
  return null
}

function imageMenuItems(diskPath) {
  return [
    {
      label: '查看图片',
      run: () => wails()?.ViewImage(diskPath).catch((e) => alert('打开查看器失败: ' + e)),
    },
    {
      label: '打开图片所在目录',
      run: () => wails()?.RevealInExplorer(diskPath).catch((e) => alert('打开目录失败: ' + e)),
    },
  ]
}

// 右键：图片 > 表格 > 系统默认菜单
elTiptapWrap.addEventListener('contextmenu', (e) => {
  // 1) 图片上右键
  const imgEl = e.target.closest('img')
  if (imgEl) {
    const diskPath = imageDiskPath(imgEl)
    if (diskPath) {
      e.preventDefault()
      showMenu(e.clientX, e.clientY, imageMenuItems(diskPath))
      return
    }
    return // 网络图片无磁盘路径，保持系统菜单
  }
  // 2) 表格内右键
  const hit = editor.view.posAtCoords({ left: e.clientX, top: e.clientY })
  if (!hit || !posInsideTable(hit.pos)) return
  e.preventDefault()
  // 把光标移动到右键位置，使行/列命令作用于点击处的表格
  editor.chain().focus().setTextSelection(hit.pos).run()
  showMenu(e.clientX, e.clientY, tableMenuItems())
})

// 点击菜单外或按 Esc 关闭
window.addEventListener('pointerdown', (e) => {
  if (!ctxMenu.classList.contains('hidden') && !ctxMenu.contains(e.target)) {
    hideCtxMenu()
  }
})
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideCtxMenu()
})

// 右键菜单（表格/图片）滚动时关闭：fixed 定位不跟随内容滚动，滞留会错位
const hideCtxMenuOnScroll = () => hideCtxMenu()
editorScrollWrap?.addEventListener('scroll', hideCtxMenuOnScroll, { passive: true })
window.addEventListener('wheel', hideCtxMenuOnScroll, { passive: true })

// ---------- 右侧目录大纲（默认折叠） ----------
const outlinePanel = $('outline-panel')
const outlineList = $('outline-list')
let outlineOpen = false

function toggleOutline(open) {
  outlineOpen = open ?? !outlineOpen
  outlinePanel.classList.toggle('open', outlineOpen)
  $('btn-outline').classList.toggle('active', outlineOpen)
}

$('btn-outline').addEventListener('click', () => toggleOutline())
$('btn-outline-close').addEventListener('click', () => toggleOutline(false))

// 从文档收集顶层标题构建大纲
function refreshOutline() {
  const items = []
  editor.state.doc.forEach((node, offset) => {
    if (node.type.name === 'heading') {
      items.push({ level: node.attrs.level, text: node.textContent, pos: offset })
    }
  })
  outlineList.innerHTML = ''
  if (!items.length) {
    const empty = document.createElement('div')
    empty.className = 'outline-empty'
    empty.textContent = '暂无标题'
    outlineList.appendChild(empty)
    return
  }
  for (const it of items) {
    const btn = document.createElement('button')
    btn.className = `outline-item lv-${it.level}`
    btn.textContent = it.text || '(空标题)'
    btn.title = it.text
    btn.addEventListener('click', () => jumpToHeading(it))
    outlineList.appendChild(btn)
  }
}

function jumpToHeading(item) {
  if (mode === 'source') {
    // 源码模式：在 markdown 源里定位对应标题行
    const prefix = '#'.repeat(item.level) + ' '
    const lines = getSourceDoc(cm).split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith(prefix) && lines[i].slice(prefix.length).includes(item.text)) {
        const line = cm.state.doc.line(i + 1)
        cm.dispatch({
          selection: { anchor: line.from },
          effects: EditorView.scrollIntoView(line.from, { y: 'start' }),
        })
        cm.focus()
        return
      }
    }
    return
  }
  // 所见即所得：滚动到标题 DOM
  try {
    const res = editor.view.domAtPos(item.pos + 1)
    const el = res.node.nodeType === 1 ? res.node : res.node.parentElement
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  } catch {
    /* pos 已失效，忽略 */
  }
}

// ---------- 文件操作 ----------
// 应用打开的文件内容（对话框打开 / 单实例远程打开 / 启动参数 共用）
function applyOpenedFile(data) {
  hideWelcome()
  clearTimeout(autoSaveTimer)
  // Go 结构体 JSON 字段为小写（json tag）
  currentPath = data.path || ''
  dirty = false
  docOpen = true
  loadContent(data.content ?? '')
  refreshHeader()
}

// 新建空白文档
function newDocument() {
  hideWelcome()
  clearTimeout(autoSaveTimer)
  currentPath = ''
  dirty = false
  docOpen = true
  loadContent('')
  refreshHeader()
  editor.commands.focus()
}

// ---------- 启动页（新建 / 打开 / 最近打开） ----------
const welcomeScreen = $('welcome-screen')
const recentListEl = $('wc-recent')
const recentItemsEl = $('wc-recent-items')

function showWelcome() {
  welcomeScreen.classList.remove('hidden')
  refreshRecentFiles()
}

function hideWelcome() {
  welcomeScreen.classList.add('hidden')
}

// 渲染最近打开的文件（点击直接打开）
async function refreshRecentFiles() {
  const app = wails()
  let list = []
  if (app) {
    try {
      list = (await app.GetRecentFiles()) || []
    } catch {
      list = []
    }
  }
  recentItemsEl.innerHTML = ''
  if (!list.length) {
    recentListEl.classList.add('hidden')
    return
  }
  for (const p of list) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'recent-item'
    btn.title = p
    const name = document.createElement('span')
    name.className = 'recent-name'
    name.textContent = displayName(p)
    const dir = document.createElement('span')
    dir.className = 'recent-dir'
    dir.textContent = dirName(p)
    btn.append(name, dir)
    btn.addEventListener('click', () => openRecentFile(p))
    recentItemsEl.appendChild(btn)
  }
  recentListEl.classList.remove('hidden')
}

async function openRecentFile(path) {
  const app = wails()
  if (!app) return
  try {
    const data = await app.OpenPath(path)
    applyOpenedFile(data)
  } catch (e) {
    alert('打开失败：' + (e?.message || e))
    // 文件可能已被移动/删除，刷新列表
    refreshRecentFiles()
  }
}

$('wc-new').addEventListener('click', newDocument)
$('wc-open').addEventListener('click', openFile)

// wails 文件拖放：.md 打开文档，图片导入编辑器
// 注意：wails 事件参数为 (x, y, paths)
const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif']

let wailsDropHandled = false // wails 路径链路是否已处理本次拖入
let pendingDrop = null // 询问打开方式时的待处理拖拽文件 {path, content, fileName}

// 拖拽 md 的统一打开入口：
// - 启动页（无编辑器打开）→ 直接当前窗口打开，不询问
// - 已有编辑器 → 按设置的 openAction 分流（询问/当前窗口/新窗口）
async function handleDroppedMarkdown(entry) {
  const app = wails()
  if (!docOpen) {
    if (entry.path && app) {
      const data = await app.OpenPath(entry.path)
      applyOpenedFile(data)
    } else {
      applyOpenedFile(entry)
    }
    return
  }
  let action = 'ask'
  if (app) {
    try {
      action = (await app.GetSettings()).openAction || 'ask'
    } catch {
      /* 读取失败按询问处理 */
    }
  }
  if (action === 'current' || !app) {
    if (entry.path && app) {
      const data = await app.OpenPath(entry.path)
      applyOpenedFile(data)
    } else {
      applyOpenedFile(entry)
    }
    return
  }
  if (action === 'new') {
    if (entry.path && app) {
      await app.OpenInNewWindow(entry.path)
    } else {
      applyOpenedFile(entry) // 无真实路径时无法开新窗口
    }
    return
  }
  // ask：弹询问框
  pendingDrop = entry
  $('open-target-name').textContent = entry.path
    ? baseName(entry.path)
    : entry.fileName || '未命名文件'
  $('btn-open-target-new').disabled = !entry.path
  $('open-target-overlay').classList.remove('hidden')
}

const openTargetOverlay = $('open-target-overlay')
$('btn-open-target-cancel').addEventListener('click', () => {
  openTargetOverlay.classList.add('hidden')
  pendingDrop = null
})
$('btn-open-target-current').addEventListener('click', async () => {
  openTargetOverlay.classList.add('hidden')
  const entry = pendingDrop
  pendingDrop = null
  if (!entry) return
  const app = wails()
  if (entry.path && app) {
    try {
      const data = await app.OpenPath(entry.path)
      applyOpenedFile(data)
    } catch (e) {
      alert('打开失败: ' + e)
    }
  } else {
    applyOpenedFile(entry)
  }
})
$('btn-open-target-new').addEventListener('click', async () => {
  openTargetOverlay.classList.add('hidden')
  const entry = pendingDrop
  pendingDrop = null
  if (!entry) return
  await wails()?.OpenInNewWindow(entry.path)
})

window.runtime?.EventsOn?.('wails:file-drop', async (x, y, paths) => {
  if (!paths || !paths.length) return
  wailsDropHandled = true
  const app = wails()
  if (!app) return

  // 优先处理拖入的 markdown 文件（走打开方式询问/分流）
  for (const p of paths) {
    const ext = (p.split('.').pop() || '').toLowerCase()
    if (ext === 'md' || ext === 'markdown') {
      try {
        await handleDroppedMarkdown({ path: p })
      } catch (e) {
        console.error(e)
        alert('打开失败: ' + e)
      }
      return
    }
  }

  // 拖入的是图片 → 导入资源目录并插入文档
  for (const p of paths) {
    const ext = (p.split('.').pop() || '').toLowerCase()
    if (imageExts.includes(ext)) {
      try {
        const res = await app.ImportImage(p)
        if (res?.src) {
          editor.chain().focus().setImage({ src: res.src }).run()
        }
      } catch (e) {
        console.error(e)
        alert('导入图片失败: ' + e)
      }
    }
  }
})

// ---------- 拖放保险层 ----------
// wails 的拖放拦截依赖运行时注入，可能未激活；这里自行阻止 WebView
// 默认行为（把 .md 当文本打开 / 弹浏览器），并在 wails 路径链路
// 未生效时降级为按内容打开（丢失文件路径关联，提示用户另存）。
const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files')

window.addEventListener(
  'dragover',
  (e) => {
    if (hasFiles(e)) e.preventDefault()
  },
  { capture: true },
)

window.addEventListener(
  'drop',
  (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()

    const files = [...(e.dataTransfer.items || [])]
      .filter((i) => i.kind === 'file')
      .map((i) => i.getAsFile())
      .filter(Boolean)
    if (!files.length) return

    // 直接通过 WebView2 原生桥请求 Go 解析真实路径。
    // 不依赖 wails 运行时的拖放模块是否激活（消息格式与 wails 一致：file:drop:<x>:<y>）
    if (window.chrome?.webview?.postMessageWithAdditionalObjects) {
      window.chrome.webview.postMessageWithAdditionalObjects(
        `file:drop:${Math.round(e.x)}:${Math.round(e.y)}`,
        files,
      )
    }

    // 兜底：400ms 内 wails 路径链路没回来，按内容处理（无路径）
    wailsDropHandled = false
    setTimeout(async () => {
      if (wailsDropHandled) return
      for (const f of files) {
        const ext = (f.name.split('.').pop() || '').toLowerCase()
        if (ext === 'md' || ext === 'markdown') {
          try {
            const text = await f.text()
            await handleDroppedMarkdown({ path: '', content: text, fileName: f.name })
          } catch (err) {
            console.error(err)
            alert('读取拖入文件失败: ' + err)
          }
          return
        }
      }
    }, 400)
  },
  { capture: true },
)

async function openFile() {
  const app = wails()
  if (!app) return
  try {
    // 先选文件，再按设置的打开方式处理（询问 / 当前窗口 / 新窗口）
    const path = await app.PickMarkdownPath()
    if (!path) return
    await handleDroppedMarkdown({ path })
  } catch (e) {
    console.error(e)
    alert('打开失败: ' + e)
  }
}

// 在新窗口打开（Ctrl+Shift+O）：选文件后起新实例，不弹单实例询问
async function openFileInNewWindow() {
  const app = wails()
  if (!app) return
  try {
    const path = await app.PickMarkdownPath()
    if (!path) return
    await app.OpenInNewWindow(path)
  } catch (e) {
    console.error(e)
    alert('打开失败: ' + e)
  }
}

function loadContent(md) {
  loading = true
  setMarkdown(editor, md)
  setSourceDoc(cm, md)
  refreshStats(md)
  refreshOutline()
  loading = false
}

function currentMarkdown() {
  return mode === 'source' ? getSourceDoc(cm) : getMarkdown(editor)
}

async function saveDocument() {
  const app = wails()
  if (!app) return
  try {
    const saved = currentPath
      ? await app.SaveMarkdown(currentMarkdown())
      : await app.SaveMarkdownAs(currentMarkdown())
    if (!saved) return // 另存为被取消
    const dirChanged = dirName(currentPath) !== dirName(saved)
    currentPath = saved
    dirty = false
    refreshHeader()
    if (dirChanged) loadContent(currentMarkdown())
  } catch (e) {
    console.error(e)
    alert('保存失败: ' + e)
  }
}

async function saveFileAs() {
  const app = wails()
  if (!app) return
  try {
    const saved = await app.SaveMarkdownAs(currentMarkdown())
    if (!saved) return
    const dirChanged = dirName(currentPath) !== dirName(saved)
    currentPath = saved
    dirty = false
    refreshHeader()
    if (dirChanged) loadContent(currentMarkdown())
  } catch (e) {
    console.error(e)
    alert('另存为失败: ' + e)
  }
}

$('btn-open').addEventListener('click', openFile)
$('btn-save').addEventListener('click', saveDocument)
$('btn-save-as').addEventListener('click', saveFileAs)

// ---------- 设置面板 ----------
const overlay = $('settings-overlay')
const selMode = $('set-asset-mode')
const inpFolder = $('set-assets-folder')
const inpCustomDir = $('set-custom-dir')
const rowFolder = $('row-assets-folder')
const rowCustomDir = $('row-custom-dir')

function refreshSettingsRows() {
  const custom = selMode.value === 'custom'
  rowFolder.classList.toggle('hidden', custom)
  rowCustomDir.classList.toggle('hidden', !custom)
}

// ---------- 主题 ----------
function applyTheme(theme) {
  document.body.classList.toggle('dark', theme !== 'light')
}

// 标题栏快捷切换：取当前设置覆盖 Theme 后保存
$('btn-theme').addEventListener('click', async () => {
  const app = wails()
  const next = document.body.classList.contains('dark') ? 'light' : 'dark'
  applyTheme(next)
  if (!app) return
  try {
    const s = await app.GetSettings()
    await app.SaveSettings({
      AssetMode: s.assetMode,
      AssetsFolder: s.assetsFolder,
      CustomDir: s.customDir,
      OpenAction: s.openAction,
      Theme: next,
    })
  } catch (e) {
    console.error(e)
  }
})

async function openSettings() {
  const app = wails()
  if (!app) return
  try {
    const s = await app.GetSettings()
    selMode.value = s.assetMode
    inpFolder.value = s.assetsFolder
    inpCustomDir.value = s.customDir || ''
    $('set-theme').value = s.theme || 'dark'
    $('set-open-action').value = s.openAction || 'ask'
    refreshSettingsRows()
    overlay.classList.remove('hidden')
  } catch (e) {
    alert('读取设置失败: ' + e)
  }
}

async function saveSettings() {
  const app = wails()
  if (!app) return
  try {
    const theme = $('set-theme').value
    await app.SaveSettings({
      AssetMode: selMode.value,
      AssetsFolder: inpFolder.value.trim() || 'assets',
      CustomDir: inpCustomDir.value,
      OpenAction: $('set-open-action').value,
      Theme: theme,
    })
    applyTheme(theme) // 立即生效
    overlay.classList.add('hidden')
  } catch (e) {
    alert('保存设置失败: ' + e)
  }
}

$('btn-settings').addEventListener('click', openSettings)
$('btn-settings-ok').addEventListener('click', saveSettings)
$('btn-settings-cancel').addEventListener('click', () => overlay.classList.add('hidden'))
overlay.addEventListener('click', (e) => {
  if (e.target === overlay) overlay.classList.add('hidden')
})
selMode.addEventListener('change', refreshSettingsRows)
$('btn-choose-dir').addEventListener('click', async () => {
  const app = wails()
  if (!app) return
  const dir = await app.ChooseDirectory()
  if (dir) inpCustomDir.value = dir
})

// ---------- 全局快捷键 ----------
// 有模态框打开时不响应，保证模态期间不能操作背后的编辑器
const hasOpenModal = () => !!document.querySelector('.modal-overlay:not(.hidden)')

window.addEventListener('keydown', (e) => {
  if (hasOpenModal()) return
  const mod = e.ctrlKey || e.metaKey
  if (!mod) return
  const k = e.key.toLowerCase()
  if (k === 's') {
    e.preventDefault()
    saveDocument()
  } else if (k === 'o') {
    e.preventDefault()
    if (e.shiftKey) openFileInNewWindow()
    else openFile()
  } else if (k === '/') {
    e.preventDefault()
    setMode(mode === 'wysiwyg' ? 'source' : 'wysiwyg')
  }
})

// ---------- 关闭流程：未保存 → 询问「保留 / 废弃」；再按设置退出或留在后台 ----------
const unsavedOverlay = $('unsaved-overlay')
let closingWithTray = true

function showUnsavedDialog() {
  $('unsaved-name').textContent = currentPath
    ? displayName(currentPath)
    : '未命名文档（保存时需要选择位置）'
  unsavedOverlay.classList.remove('hidden')
}

// 已命名的文件本来就有自动保存，关闭时补存一次，避免 2s 防抖误报未保存
async function flushAutoSave() {
  if (!dirty) return true
  if (!currentPath) return false
  const app = wails()
  if (!app) return false
  try {
    await app.SaveMarkdown(currentMarkdown())
    dirty = false
    refreshHeader()
    return true
  } catch (e) {
    console.error('关闭前保存失败', e)
    return false
  }
}

async function onCloseRequested(hasTray) {
  closingWithTray = !!hasTray
  if (!(await flushAutoSave())) {
    showUnsavedDialog()
    return
  }
  await finishClose()
}

// 未保存内容处理完（或本来就没有）后，按设置决定退出方式
async function finishClose() {
  const app = wails()
  if (!app) return
  if (!closingWithTray) {
    app.ConfirmClose('exit', false) // 附属窗口没有托盘，直接退出
    return
  }
  let action = 'ask'
  try {
    action = (await app.GetSettings()).closeAction || 'ask'
  } catch {
    /* 读取失败按询问处理 */
  }
  if (action === 'exit') app.ConfirmClose('exit', false)
  else if (action === 'background') app.ConfirmClose('background', false)
  else showExitDialog()
}

$('btn-unsaved-cancel').addEventListener('click', () => unsavedOverlay.classList.add('hidden'))
$('btn-unsaved-discard').addEventListener('click', async () => {
  unsavedOverlay.classList.add('hidden')
  dirty = false
  refreshHeader()
  await finishClose()
})
$('btn-unsaved-save').addEventListener('click', async () => {
  const app = wails()
  if (!app) return
  try {
    const saved = currentPath
      ? await app.SaveMarkdown(currentMarkdown())
      : await app.SaveMarkdownAs(currentMarkdown())
    if (!saved) return // 取消选择保存位置 → 留在编辑器
    currentPath = saved
    dirty = false
    refreshHeader()
  } catch (e) {
    alert('保存失败: ' + e)
    return
  }
  unsavedOverlay.classList.add('hidden')
  await finishClose()
})

// ---------- 关闭询问（退出 / 留在后台托盘） ----------
const exitOverlay = $('exit-overlay')

function showExitDialog() {
  $('exit-remember').checked = false
  exitOverlay.classList.remove('hidden')
}

$('btn-exit-cancel').addEventListener('click', () => exitOverlay.classList.add('hidden'))
$('btn-exit-quit').addEventListener('click', () => {
  exitOverlay.classList.add('hidden')
  wails()?.ConfirmClose('exit', $('exit-remember').checked)
})
$('btn-exit-background').addEventListener('click', () => {
  exitOverlay.classList.add('hidden')
  wails()?.ConfirmClose('background', $('exit-remember').checked)
})

// Go 侧关闭拦截 → 先处理未保存内容，再询问退出方式
window.runtime?.EventsOn?.('close-requested', (hasTray) => onCloseRequested(hasTray))

// 单实例：第二实例请求打开文件
window.runtime?.EventsOn?.('open-file', (data) => applyOpenedFile(data))

// 关闭到后台后再打开：回到启动页（不再显示上次关闭的文档）
function resetToWelcome() {
  clearTimeout(autoSaveTimer)
  // 内容已自动保存（已命名的文件写盘），这里只清空界面与当前路径
  currentPath = ''
  dirty = false
  docOpen = false
  setMode('wysiwyg')
  loadContent('')
  refreshHeader()
  wails()?.ClosePath()
  showWelcome()
}

// 窗口被唤出（托盘/再次双击 exe）：
// 关闭到后台的重开 → 启动页；尚未进入编辑状态 → 补显启动页
window.runtime?.EventsOn?.('window-shown', (reset) => {
  if (reset && docOpen) resetToWelcome()
  else if (!docOpen) showWelcome()
})

// ---------- 设置面板加：注册 .md 文件关联 ----------
$('btn-register-md').addEventListener('click', async () => {
  const app = wails()
  if (!app) return
  try {
    const msg = await app.RegisterMdAssociation()
    alert(msg)
  } catch (e) {
    alert('注册失败: ' + e)
  }
})

// ---------- 初始化 ----------
async function init() {
  const app = wails()
  // 先应用主题，避免暗色用户看到闪白
  applyTheme('dark')
  try {
    if (app) {
      const s = await app.GetSettings()
      applyTheme(s.theme)
    }
  } catch (e) {
    console.error(e)
  }
  refreshHeader()
  refreshStats(getMarkdown(editor))
  refreshOutline()
  if (!app) return
  // 命令行带入的文件（双击 .md / 右键打开方式）
  let opened = false
  try {
    const startupFile = await app.GetStartupFile()
    if (startupFile) {
      applyOpenedFile(startupFile)
      opened = true
    }
  } catch (e) {
    console.error(e)
  }
  if (!opened) showWelcome()
  else editor.commands.focus()
}
init()
