import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Condition, Effect, Value, Variable } from '../core/model';

export function ValueInput({
  type,
  value,
  onChange,
  label,
  disabled,
}: {
  type: Variable['type'];
  value: Value;
  onChange: (v: Value) => void;
  label?: string;
  disabled?: boolean;
}) {
  if (type === 'boolean')
    return (
      <select
        disabled={disabled}
        aria-label={label ?? '布尔值'}
        value={String(value)}
        onChange={(e) => onChange(e.target.value === 'true')}
      >
        <option value="true">是 / true</option>
        <option value="false">否 / false</option>
      </select>
    );
  if (type === 'number')
    return <NumericValueInput value={Number(value)} onChange={onChange} label={label} disabled={disabled} />;
  return (
    <input
      disabled={disabled}
      aria-label={label ?? '变量值'}
      type="text"
      maxLength={10_000}
      value={String(value)}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
function NumericValueInput({
  value,
  onChange,
  label,
  disabled,
}: {
  value: number;
  onChange: (v: Value) => void;
  label?: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);
  return (
    <input
      disabled={disabled}
      aria-label={label ?? '变量值'}
      type="text"
      inputMode="decimal"
      value={draft}
      onChange={(event) => {
        const text = event.target.value;
        setDraft(text);
        if (text.trim() && Number.isFinite(Number(text))) onChange(Number(text));
      }}
      onBlur={() => {
        if (!draft.trim() || !Number.isFinite(Number(draft))) setDraft(String(value));
      }}
    />
  );
}
export function defaultCondition(v: Variable): Condition {
  return { variableId: v.id, operator: 'eq', value: v.defaultValue };
}
export function ConditionFields({
  variables,
  value,
  onChange,
}: {
  variables: Variable[];
  value: Condition;
  onChange: (v: Condition) => void;
}) {
  const variable = variables.find((v) => v.id === value.variableId);
  return (
    <div className="condition-fields">
      <select
        aria-label="条件变量"
        value={value.variableId}
        onChange={(e) => {
          const v = variables.find((v) => v.id === e.target.value)!;
          onChange(defaultCondition(v));
        }}
      >
        {!variable && <option value={value.variableId}>变量已丢失</option>}
        {variables.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name || v.key}
          </option>
        ))}
      </select>
      <div className="field-row">
        <select
          aria-label="比较方式"
          value={value.operator}
          onChange={(e) => onChange({ ...value, operator: e.target.value as Condition['operator'] })}
        >
          <option value="eq">等于</option>
          <option value="neq">不等于</option>
          {variable?.type === 'number' && (
            <>
              <option value="gt">大于</option>
              <option value="gte">大于等于</option>
              <option value="lt">小于</option>
              <option value="lte">小于等于</option>
            </>
          )}
        </select>
        <ValueInput
          type={variable?.type ?? 'string'}
          value={value.value}
          onChange={(v) => onChange({ ...value, value: v })}
        />
      </div>
    </div>
  );
}
export function EffectFields({
  variables,
  value,
  onChange,
}: {
  variables: Variable[];
  value: Effect[];
  onChange: (v: Effect[]) => void;
}) {
  return (
    <div className="effect-fields">
      {value.map((effect, i) => {
        const v = variables.find((v) => v.id === effect.variableId);
        const update = (e: Effect) => onChange(value.map((old, j) => (j === i ? e : old)));
        return (
          <div className="effect-item" key={i}>
            <div className="field-row">
              <select
                aria-label="效果变量"
                value={effect.variableId}
                onChange={(e) => {
                  const v = variables.find((v) => v.id === e.target.value)!;
                  update({ variableId: v.id, operation: 'set', value: v.defaultValue });
                }}
              >
                {!v && <option value={effect.variableId}>变量已丢失</option>}
                {variables.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name || v.key}
                  </option>
                ))}
              </select>
              <button
                className="icon-button danger"
                title="删除效果"
                onClick={() => onChange(value.filter((_, j) => j !== i))}
              >
                <Trash2 size={14} />
              </button>
            </div>
            <div className="field-row">
              <select
                aria-label="效果操作"
                value={effect.operation}
                onChange={(e) => update({ ...effect, operation: e.target.value as Effect['operation'] })}
              >
                <option value="set">设为</option>
                {v?.type === 'number' && (
                  <>
                    <option value="add">增加</option>
                    <option value="subtract">减少</option>
                  </>
                )}
              </select>
              <ValueInput
                type={v?.type ?? 'string'}
                value={effect.value}
                onChange={(value) => update({ ...effect, value })}
              />
            </div>
          </div>
        );
      })}
      <button
        className="text-button small"
        disabled={!variables.length}
        onClick={() =>
          onChange([
            ...value,
            { variableId: variables[0].id, operation: 'set', value: variables[0].defaultValue },
          ])
        }
      >
        <Plus size={13} />
        添加变量效果
      </button>
      {!variables.length && <p className="field-help">先在左侧创建变量。</p>}
    </div>
  );
}
