import { useState } from 'react'
import type { ReplyInput } from '../lib/session-controller.ts'
import type { Interaction, Question } from '../lib/session-state.ts'
import { Spinner } from './ui.tsx'

/** Only a one-time approval gets the primary style; grants that outlive this request must not be the easy click. */
function isAllowOnce(kind: string): boolean {
  return kind === 'allow_once'
}

function isPersistentAllow(kind: string): boolean {
  return kind.startsWith('allow') && !isAllowOnce(kind)
}

function QuestionBlock({ question, value, onChange }: { question: Question; value: string[]; onChange: (value: string[]) => void }) {
  const [custom, setCustom] = useState('')
  const known = question.options.map((option) => option.label)
  const selected = value.filter((item) => known.includes(item))

  function emit(nextSelected: string[], nextCustom: string): void {
    onChange(nextCustom.trim() ? [...nextSelected, nextCustom.trim()] : nextSelected)
  }

  function toggle(label: string): void {
    if (question.multiSelect) {
      emit(selected.includes(label) ? selected.filter((item) => item !== label) : [...selected, label], custom)
    } else {
      setCustom('')
      onChange([label])
    }
  }

  return (
    <fieldset className="question">
      <legend>{question.header && <span className="question-header">{question.header}</span>}{question.question}</legend>
      {question.options.map((option) => (
        <label key={option.label} className={`question-option${selected.includes(option.label) ? ' selected' : ''}`}>
          <input
            type={question.multiSelect ? 'checkbox' : 'radio'}
            name={question.key}
            checked={selected.includes(option.label)}
            onChange={() => toggle(option.label)}
          />
          <span>
            <span className="question-label">{option.label}</span>
            {option.description && <span className="question-description">{option.description}</span>}
          </span>
        </label>
      ))}
      <input
        className="input"
        placeholder={question.options.length > 0 ? '或输入其他回答' : '输入回答'}
        aria-label={`${question.question}：其他回答`}
        value={custom}
        onChange={(event) => {
          setCustom(event.target.value)
          emit(question.multiSelect ? selected : [], event.target.value)
        }}
      />
    </fieldset>
  )
}

/** Approvals never resolve on their own: the user always sees what is being approved and picks an offered action. */
export function InteractionCard({ interaction, onReply }: { interaction: Interaction; onReply: (reply: ReplyInput) => Promise<void> }) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({})
  const [busy, setBusy] = useState(false)
  const isQuestion = interaction.questions.length > 0
  const complete = interaction.questions.every((question) => (answers[question.key]?.length ?? 0) > 0)
  const persistent = interaction.options.filter((option) => isPersistentAllow(option.kind))

  async function submit(outcome: ReplyInput['outcome']): Promise<void> {
    setBusy(true)
    try {
      const encoded: Record<string, string> = {}
      for (const question of interaction.questions) {
        const answer = answers[question.key]
        if (answer?.length) encoded[question.key] = answer.join(', ')
      }
      await onReply({
        requestId: interaction.requestId,
        outcome,
        ...(isQuestion && outcome.outcome === 'selected' ? { answers: encoded } : {}),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="interaction" aria-label={isQuestion ? '需要你回答' : '需要你确认'}>
      <div className="interaction-kind">{isQuestion ? '需要你回答' : '需要你确认'}</div>
      {interaction.title && <h3>{interaction.title}</h3>}
      {isQuestion
        ? interaction.questions.map((question) => (
            <QuestionBlock
              key={question.key}
              question={question}
              value={answers[question.key] ?? []}
              onChange={(value) => setAnswers((current) => ({ ...current, [question.key]: value }))}
            />
          ))
        : interaction.rawInput !== undefined && <pre className="interaction-input">{JSON.stringify(interaction.rawInput, null, 2)}</pre>}
      <div className="interaction-actions">
        {busy && <Spinner size="sm" />}
        <button type="button" className="button" disabled={busy} onClick={() => void submit({ outcome: 'cancelled' })}>取消</button>
        {interaction.options.map((option) => (
          <button
            key={option.optionId}
            type="button"
            className={`button${isAllowOnce(option.kind) ? ' button-primary' : ''}`}
            disabled={busy || (isQuestion && !complete)}
            onClick={() => void submit({ outcome: 'selected', optionId: option.optionId })}
          >
            {option.name}
          </button>
        ))}
      </div>
      {persistent.length > 0 && (
        <p className="interaction-note">
          {persistent.map((option) => `“${option.name}”`).join('、')}会让之后的同类操作不再询问。
        </p>
      )}
    </section>
  )
}
