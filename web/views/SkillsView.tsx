import { Download, Pencil, Plus, Search, Sparkles, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ConfirmDialog, Dialog, ErrorBanner, Field, MarkdownText, Spinner } from '../components/ui.tsx'
import { createSkill, deleteSkill, getSkill, listSkills, updateSkill, type SkillDetail, type SkillSource, type SkillSummary } from '../lib/ada.ts'
import { errorText } from '../lib/api.ts'

export function SkillsView() {
  const [skills, setSkills] = useState<SkillSummary[]>()
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [viewing, setViewing] = useState<string>()
  const [editing, setEditing] = useState<SkillDetail | 'new'>()
  const [removing, setRemoving] = useState<SkillDetail>()

  const refresh = useCallback(async () => {
    try {
      setSkills(await listSkills())
      setError('')
    } catch (reason) {
      setError(errorText(reason))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return (skills ?? []).filter((skill) => !keyword || `${skill.name} ${skill.description}`.toLowerCase().includes(keyword))
  }, [skills, query])

  return (
    <div className="page">
      <div className="page-head">
        <h1>技能</h1>
        <button type="button" className="button button-primary" onClick={() => setEditing('new')}><Plus size={16} />新建技能</button>
      </div>
      <div className="toolbar">
        <div className="search-box search-box-toolbar">
          <Search size={16} />
          <input value={query} placeholder="搜索技能" aria-label="搜索技能" onChange={(event) => setQuery(event.target.value)} />
        </div>
      </div>
      {error && <ErrorBanner message={error} />}
      {!skills && !error && <div className="page-loading"><Spinner /></div>}
      {skills && visible.length === 0 && <div className="empty">没有符合条件的技能</div>}
      <div className="card-grid card-grid-skills">
        {visible.map((skill) => (
          <article key={skill.name} className="card">
            <button type="button" className="card-main" onClick={() => setViewing(skill.name)}>
              <span className="skill-icon"><Sparkles size={18} /></span>
              <span className="card-text">
                <span className="card-title">
                  <span className="truncate">{skill.name}</span>
                  <span className={`badge${skill.official ? ' badge-official' : ''}`}>{skill.official ? '官方' : '自定义'}</span>
                </span>
                <span className="card-description">{skill.description || '暂无描述'}</span>
              </span>
            </button>
          </article>
        ))}
      </div>
      {viewing && (
        <SkillDetailDialog
          name={viewing}
          onClose={() => setViewing(undefined)}
          onEdit={(skill) => {
            setViewing(undefined)
            setEditing(skill)
          }}
          onDelete={(skill) => {
            setViewing(undefined)
            setRemoving(skill)
          }}
        />
      )}
      {editing && (
        <SkillEditor
          {...(editing === 'new' ? {} : { current: editing })}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined)
            void refresh()
          }}
        />
      )}
      {removing && (
        <ConfirmDialog
          title="删除技能"
          message={`确定删除“${removing.name}”吗？删除后不能恢复，但可以重新创建同名技能。`}
          confirmLabel="删除"
          onCancel={() => setRemoving(undefined)}
          onConfirm={async () => {
            await deleteSkill(removing.name)
            setRemoving(undefined)
            await refresh()
          }}
        />
      )}
    </div>
  )
}

function SkillDetailDialog({ name, onClose, onEdit, onDelete }: {
  name: string
  onClose: () => void
  onEdit: (skill: SkillDetail) => void
  onDelete: (skill: SkillDetail) => void
}) {
  const [skill, setSkill] = useState<SkillDetail>()
  const [error, setError] = useState('')
  useEffect(() => {
    getSkill(name).then(setSkill).catch((reason: unknown) => setError(errorText(reason)))
  }, [name])
  return (
    <Dialog title={name} onClose={onClose} wide>
      <div className="dialog-body">
        {error && <ErrorBanner message={error} />}
        {!skill && !error && <div className="page-loading"><Spinner /></div>}
        {skill && (
          <>
            {skill.description && <p className="dialog-message">{skill.description}</p>}
            {skill.skillMd
              ? <div className="skill-body"><MarkdownText text={skill.skillMd} /></div>
              : <p className="muted">这个技能的内容保存在 Bundle 中。</p>}
          </>
        )}
      </div>
      <div className="dialog-actions">
        {skill?.canDelete && <button type="button" className="button button-danger-quiet" onClick={() => onDelete(skill)}><Trash2 size={14} />删除</button>}
        <span className="spacer" />
        {skill?.downloadUrl && (
          <a className="button" href={skill.downloadUrl} target="_blank" rel="noopener noreferrer"><Download size={14} />下载 Bundle</a>
        )}
        {skill?.canModify && <button type="button" className="button button-primary" onClick={() => onEdit(skill)}><Pencil size={14} />编辑</button>}
      </div>
    </Dialog>
  )
}

type SourceKind = 'skillMd' | 'bundleUrl'

function SkillEditor({ current, onClose, onSaved }: { current?: SkillDetail; onClose: () => void; onSaved: () => void }) {
  const isBundle = Boolean(current && !current.skillMd)
  const [name, setName] = useState(current?.name ?? '')
  const [description, setDescription] = useState(current?.description ?? '')
  const [visibility, setVisibility] = useState(current?.visibility ?? 'user')
  const [kind, setKind] = useState<SourceKind>(isBundle ? 'bundleUrl' : 'skillMd')
  const [skillMd, setSkillMd] = useState(current?.skillMd ?? '')
  const [bundleUrl, setBundleUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const nameValid = /^[A-Za-z0-9_-]{1,64}$/.test(name)
  const bundleValid = /^https:\/\/\S+$/.test(bundleUrl.trim())
  /** Metadata replaces the saved content as a whole, so it is left out unless the content changed. */
  const source: SkillSource | undefined =
    kind === 'skillMd'
      ? skillMd.trim() && skillMd !== current?.skillMd ? { skillMd } : undefined
      : bundleValid ? { bundleUrl: bundleUrl.trim() } : undefined
  const canSave = nameValid && Boolean(description.trim()) && (current ? kind === 'skillMd' ? Boolean(skillMd.trim()) || isBundle : !bundleUrl.trim() || bundleValid : Boolean(source))

  async function save(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      if (current) {
        await updateSkill(current.name, {
          ...(description !== current.description ? { description } : {}),
          ...(visibility !== current.visibility ? { visibility } : {}),
          ...(source ? { source, extraMetadata: current.extraMetadata } : {}),
        })
      } else if (source) {
        await createSkill({ name, description, visibility, source })
      }
      onSaved()
    } catch (reason) {
      setError(errorText(reason))
      setBusy(false)
    }
  }

  return (
    <Dialog title={current ? `编辑 ${current.name}` : '新建技能'} onClose={onClose} wide>
      <div className="dialog-body form">
        <Field label="名称" hint="创建后不可修改。只能使用英文字母、数字、下划线和连字符，最多 64 个字符。">
          <input className="input" value={name} disabled={Boolean(current)} maxLength={64} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="描述"><input className="input" value={description} onChange={(event) => setDescription(event.target.value)} /></Field>
        <div className="field" role="radiogroup" aria-label="内容来源">
          <span className="field-label">内容来源</span>
          <div className="segmented segmented-inline">
            <button type="button" role="radio" aria-checked={kind === 'skillMd'} className={kind === 'skillMd' ? 'selected' : ''} onClick={() => setKind('skillMd')}>Markdown</button>
            <button type="button" role="radio" aria-checked={kind === 'bundleUrl'} className={kind === 'bundleUrl' ? 'selected' : ''} onClick={() => setKind('bundleUrl')}>ZIP 链接</button>
          </div>
        </div>
        {kind === 'skillMd' ? (
          <Field label="Skill 正文" hint="直接填写 Markdown 正文，无需 YAML 头部。">
            <textarea className="input textarea textarea-code" rows={10} value={skillMd} onChange={(event) => setSkillMd(event.target.value)} />
          </Field>
        ) : (
          <Field label="ZIP 直链" hint={current ? '留空表示不更换内容。仅支持公网 HTTPS 直链，不跟随跳转，大小不超过 10 MiB。' : '仅支持公网 HTTPS 直链，不跟随跳转，大小不超过 10 MiB。'}>
            <input className="input" value={bundleUrl} placeholder="https://example.com/skill.zip" onChange={(event) => setBundleUrl(event.target.value)} />
          </Field>
        )}
        <Field label="可见范围">
          <select className="input" value={visibility} onChange={(event) => setVisibility(event.target.value)}>
            <option value="user">仅自己可见</option>
            <option value="tenant">租户内可见</option>
          </select>
        </Field>
        {error && <ErrorBanner message={error} />}
      </div>
      <div className="dialog-actions">
        <button type="button" className="button" onClick={onClose}>取消</button>
        <button type="button" className="button button-primary" disabled={busy || !canSave} onClick={() => void save()}>
          {busy && <Spinner size="sm" />}保存
        </button>
      </div>
    </Dialog>
  )
}
