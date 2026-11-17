import { ExternalLink, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import type { ConfigStatus } from '../../server/config.ts'
import { ConfirmDialog, ErrorBanner, Field, Spinner } from '../components/ui.tsx'
import { clearCredentials, errorText, saveCredentials } from '../lib/api.ts'

const REGION_NAMES: Readonly<Record<string, string>> = {
  'cn-hangzhou': '华东1（杭州）cn-hangzhou',
  'cn-shanghai': '华东2（上海）cn-shanghai',
  'cn-beijing': '华北2（北京）cn-beijing',
}

export function SettingsView({ config, onChange, firstRun }: { config: ConfigStatus; onChange: (config: ConfigStatus) => void; firstRun?: boolean }) {
  const [accessKeyId, setAccessKeyId] = useState('')
  const [accessKeySecret, setAccessKeySecret] = useState('')
  const [securityToken, setSecurityToken] = useState('')
  const [region, setRegion] = useState<string>(config.region)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [clearing, setClearing] = useState(false)
  const managedByEnv = config.source === 'env'

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setBusy(true)
    setError('')
    setSaved(false)
    try {
      const next = await saveCredentials({
        accessKeyId: accessKeyId.trim(),
        accessKeySecret: accessKeySecret.trim(),
        region,
        ...(securityToken.trim() ? { securityToken: securityToken.trim() } : {}),
      })
      setAccessKeyId('')
      setAccessKeySecret('')
      setSecurityToken('')
      setSaved(true)
      onChange(next)
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={firstRun ? 'setup-card' : 'page page-narrow'}>
      {firstRun ? (
        <>
          <h1 className="setup-title">开始使用 OpenADA</h1>
          <p className="setup-subtitle">填入阿里云 AccessKey，即可在本机使用 ADA。</p>
        </>
      ) : (
        <div className="page-head"><h1>设置</h1></div>
      )}

      {config.configured && (
        <section className="settings-current">
          <h2 className="section-title">当前凭证</h2>
          <dl className="detail-list">
            <div className="detail-row"><dt>AccessKey ID</dt><dd>{config.accessKeyIdMasked}</dd></div>
            <div className="detail-row"><dt>来源</dt><dd>{managedByEnv ? '环境变量' : '本地文件 .env.local'}</dd></div>
            {config.usesSecurityToken && <div className="detail-row"><dt>类型</dt><dd>STS 临时凭证</dd></div>}
          </dl>
          {!managedByEnv && <button type="button" className="button button-danger-quiet" onClick={() => setClearing(true)}>移除凭证</button>}
        </section>
      )}

      {managedByEnv ? (
        <p className="muted">当前凭证来自环境变量。如需更换，请修改环境变量后重启服务。</p>
      ) : (
        <form className="form" onSubmit={(event) => void submit(event)}>
          {config.configured && <h2 className="section-title">更换凭证</h2>}
          <Field label="AccessKey ID">
            <input className="input" value={accessKeyId} autoComplete="off" spellCheck={false} required onChange={(event) => setAccessKeyId(event.target.value)} />
          </Field>
          <Field label="AccessKey Secret">
            <input className="input" type="password" value={accessKeySecret} autoComplete="new-password" required onChange={(event) => setAccessKeySecret(event.target.value)} />
          </Field>
          <Field label="STS Token（可选）" hint="使用 STS 临时凭证时填写。过期后需要重新配置。">
            <input className="input" type="password" value={securityToken} autoComplete="off" onChange={(event) => setSecurityToken(event.target.value)} />
          </Field>
          <Field label="地域" hint="智能体和会话归属于地域，切换后看到的内容会不同。">
            <select className="input" value={region} onChange={(event) => setRegion(event.target.value)}>
              {config.regions.map((item) => <option key={item} value={item}>{REGION_NAMES[item] ?? item}</option>)}
            </select>
          </Field>
          {error && <ErrorBanner message={error} />}
          {saved && <div className="banner banner-success" role="status">凭证验证通过，已保存。</div>}
          <button type="submit" className="button button-primary button-block" disabled={busy || !accessKeyId.trim() || !accessKeySecret.trim()}>
            {busy && <Spinner size="sm" />}验证并保存
          </button>
        </form>
      )}

      <div className="security-note">
        <ShieldCheck size={16} />
        <div>
          <p>AccessKey 只保存在本机（权限 600 的 <code>.env.local</code>），只用于在本地签名发往阿里云的请求，不会发送给浏览器页面或第三方。</p>
          <p>建议使用仅具备所需权限的 RAM 用户，不要使用主账号 AccessKey。</p>
          <a href="https://help.aliyun.com/zh/ram/user-guide/create-an-accesskey-pair" target="_blank" rel="noopener noreferrer">如何获取 AccessKey <ExternalLink size={12} /></a>
        </div>
      </div>

      {clearing && (
        <ConfirmDialog
          title="移除凭证"
          message="将从本机删除已保存的 AccessKey。阿里云上的 AccessKey 本身不受影响。"
          confirmLabel="移除"
          onCancel={() => setClearing(false)}
          onConfirm={async () => {
            onChange(await clearCredentials())
            setClearing(false)
          }}
        />
      )}
    </div>
  )
}
