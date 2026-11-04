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
const elTiptapWrap = $('tiptap-editor')
const elCmWrap = $('codemirror-editor')

// ---------- 状态 ----------
let currentPath = '' // 显示用文件路径
let currentDraft = '' // 未命名文档对应的草稿文件路径（自动保存用）
let dirty = false
let mode = 'wysiwyg' // 'wysiwyg' | 'source'

function baseName(p) {
  if (!p) return '未命名'
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return i >= 0 ? p.slice(i + 1) : p
}

function dirName(p) {
  if (!p) return ''
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return i > 0 ? p.slice(0, i) : ''
}

function refreshHeader() {
  elTitle.textContent = baseName(currentPath) + (dirty ? ' ●' : '')
  elDirty.textContent = dirty ? '未保存' : '已保存'
}

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

// ---------- 自动保存（防抖 2s；未命名时写入软件目录草稿） ----------
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
  try {
    const md = currentMarkdown()
    if (currentPath) {
      await app.SaveMarkdown(md)
    } else {
      currentDraft = await app.AutoSaveDraft(currentDraft, md)
    }
    dirty = false
    refreshHeader()
    elDirty.textContent = `已自动保存 ${nowTime()}`
  } catch (e) {
    console.error('自动保存失败', e)
  }
}

// 正式保存成功后清理对应草稿
function cleanupDraft() {
  const app = wails()
  if (currentDraft && app) {
    app.DeleteDraft(currentDraft).catch(() => {})
  }
  currentDraft = ''
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

// ---------- CodeMirror ----------
const cm = createSourceEditor(elCmWrap, {
  onChange: (text) => {
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
    setSourceDoc(cm, getMarkdown(editor))
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
  cleanupDraft() // 之前的未命名草稿不再关联当前文档
  // Go 结构体 JSON 字段为小写（json tag）
  currentPath = data.path || ''
  currentDraft = ''
  dirty = false
  loadContent(data.content ?? '')
  refreshHeader()
}

// 新建空白文档
function newDocument() {
  hideWelcome()
  clearTimeout(autoSaveTimer)
  cleanupDraft()
  currentPath = ''
  currentDraft = ''
  dirty = false
  loadContent('')
  refreshHeader()
  editor.commands.focus()
}

// ---------- 启动页（新建 / 打开 / 拖拽） ----------
const welcomeScreen = $('welcome-screen')

function showWelcome() {
  welcomeScreen.classList.remove('hidden')
}

function hideWelcome() {
  welcomeScreen.classList.add('hidden')
}

$('wc-new').addEventListener('click', newDocument)
$('wc-open').addEventListener('click', openFile)

// wails 文件拖放：.md 打开文档，图片导入编辑器
const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif']

window.runtime?.EventsOn?.('wails:file-drop', async (paths) => {
  if (!paths || !paths.length) return
  const app = wails()
  if (!app) return

  // 优先处理拖入的 markdown 文件
  for (const p of paths) {
    const ext = (p.split('.').pop() || '').toLowerCase()
    if (ext === 'md' || ext === 'markdown') {
      try {
        const data = await app.OpenPath(p)
        applyOpenedFile(data)
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

async function openFile() {
  const app = wails()
  if (!app) return
  try {
    const data = await app.OpenMarkdown()
    if (!data) return // 取消
    applyOpenedFile(data)
  } catch (e) {
    console.error(e)
    alert('打开失败: ' + e)
  }
}

function loadContent(md) {
  setMarkdown(editor, md)
  setSourceDoc(cm, md)
  refreshStats(md)
  refreshOutline()
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
    cleanupDraft() // 已有正式归宿，草稿不再需要
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
    cleanupDraft()
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

async function openSettings() {
  const app = wails()
  if (!app) return
  try {
    const s = await app.GetSettings()
    selMode.value = s.assetMode
    inpFolder.value = s.assetsFolder
    inpCustomDir.value = s.customDir || ''
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
    await app.SaveSettings({
      AssetMode: selMode.value,
      AssetsFolder: inpFolder.value.trim() || 'assets',
      CustomDir: inpCustomDir.value,
      OpenAction: $('set-open-action').value,
    })
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
window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey
  if (!mod) return
  const k = e.key.toLowerCase()
  if (k === 's') {
    e.preventDefault()
    saveDocument()
  } else if (k === 'o') {
    e.preventDefault()
    openFile()
  } else if (k === '/') {
    e.preventDefault()
    setMode(mode === 'wysiwyg' ? 'source' : 'wysiwyg')
  }
})

// ---------- 草稿恢复（启动时） ----------
const draftsOverlay = $('drafts-overlay')
const draftsList = $('drafts-list')

async function refreshDraftsList() {
  const app = wails()
  if (!app) return
  const drafts = await app.ListDrafts()
  draftsList.innerHTML = ''
  if (!drafts.length) {
    draftsOverlay.classList.add('hidden')
    return
  }
  for (const d of drafts) {
    const row = document.createElement('div')
    row.className = 'draft-item'

    const info = document.createElement('div')
    info.className = 'draft-info'
    const name = document.createElement('div')
    name.className = 'draft-name'
    name.textContent = d.name
    const meta = document.createElement('div')
    meta.className = 'draft-meta'
    meta.textContent = `${d.modTime} · ${Math.max(0.1, Math.round(d.size / 102.4) / 10)} KB`
    info.appendChild(name)
    info.appendChild(meta)

    const actions = document.createElement('div')
    actions.className = 'draft-actions'
    const btnOpen = document.createElement('button')
    btnOpen.textContent = '打开'
    btnOpen.className = 'primary'
    btnOpen.addEventListener('click', async () => {
      try {
        const content = await app.ReadDraft(d.path)
        clearTimeout(autoSaveTimer)
        currentPath = ''
        currentDraft = d.path // 继续自动保存到该草稿
        dirty = false
        loadContent(content)
        refreshHeader()
        draftsOverlay.classList.add('hidden')
      } catch (e) {
        alert('读取草稿失败: ' + e)
      }
    })
    const btnDel = document.createElement('button')
    btnDel.textContent = '删除'
    btnDel.addEventListener('click', async () => {
      await app.DeleteDraft(d.path)
      refreshDraftsList()
    })
    actions.appendChild(btnOpen)
    actions.appendChild(btnDel)

    row.appendChild(info)
    row.appendChild(actions)
    draftsList.appendChild(row)
  }
  draftsOverlay.classList.remove('hidden')
}

$('btn-drafts-close').addEventListener('click', () => {
  draftsOverlay.classList.add('hidden')
  showWelcome() // 暂不处理草稿 → 进入启动页
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

// Go 侧关闭拦截 → 弹询问
window.runtime?.EventsOn?.('close-requested', showExitDialog)

// 单实例：第二实例请求打开文件
window.runtime?.EventsOn?.('open-file', (data) => applyOpenedFile(data))

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
  refreshHeader()
  refreshStats(getMarkdown(editor))
  refreshOutline()
  const app = wails()
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
  try {
    const drafts = await app.ListDrafts()
    if (drafts && drafts.length) {
      refreshDraftsList() // 恢复草稿或点“暂不处理”后决定是否进启动页
      return
    }
  } catch (e) {
    console.error(e)
  }
  if (!opened) showWelcome()
  else editor.commands.focus()
}
init()
