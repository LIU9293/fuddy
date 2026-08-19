import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

export function moveMenuIndex(
  currentIndex: number,
  itemCount: number,
  key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End'
): number {
  if (itemCount <= 0) return -1
  if (key === 'Home') return 0
  if (key === 'End') return itemCount - 1
  if (key === 'ArrowDown') return (Math.max(-1, currentIndex) + 1) % itemCount
  return (currentIndex <= 0 ? itemCount : currentIndex) - 1
}

export interface SelectMenuOption<T extends string> {
  value: T
  label: string
  icon?: ReactNode
}

export interface ActionMenuOption<T extends string> {
  value: T
  label: string
  icon?: ReactNode
  danger?: boolean
}

interface SelectMenuProps<T extends string> {
  value: T
  options: readonly SelectMenuOption<T>[]
  onChange: (value: T) => void
  ariaLabel: string
  className?: string
  leading?: ReactNode
  disabled?: boolean
  position?: 'up' | 'down'
}

export function SelectMenu<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className = '',
  leading,
  disabled = false,
  position = 'down'
}: SelectMenuProps<T>): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const listboxId = useId()
  const selected = options.find((option) => option.value === value) ?? options[0]
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value))

  function closeMenu(restoreFocus = false): void {
    setOpen(false)
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus())
  }

  function openMenu(index = selectedIndex): void {
    setActiveIndex(index)
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    window.requestAnimationFrame(() => optionRefs.current[activeIndex]?.focus())
  }, [activeIndex, open])

  useEffect(() => {
    if (!open) return

    function closeOutside(event: PointerEvent): void {
      if (!rootRef.current?.contains(event.target as Node)) closeMenu()
    }

    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key === 'Escape') closeMenu(true)
    }

    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  return (
    <div
      className={`select-menu ${position === 'up' ? 'opens-up' : ''} ${open ? 'is-open' : ''} ${className}`.trim()}
      ref={rootRef}
    >
      <button
        type="button"
        className="select-menu-trigger"
        aria-label={ariaLabel}
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={disabled}
        ref={triggerRef}
        onClick={() => open ? closeMenu() : openMenu()}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
            event.preventDefault()
            openMenu(moveMenuIndex(selectedIndex, options.length, event.key))
          }
        }}
      >
        <span className="select-menu-value">
          {leading ?? selected?.icon}
          <span>{selected?.label ?? value}</span>
        </span>
        <ChevronDown className="select-menu-chevron" size={13} />
      </button>

      {open && (
        <div className="select-menu-popover" id={listboxId} role="listbox" aria-label={ariaLabel}>
          {options.map((option, index) => {
            const isSelected = option.value === value
            return (
              <button
                type="button"
                role="option"
                aria-selected={isSelected}
                className={`select-menu-option ${isSelected ? 'is-selected' : ''}`}
                key={option.value}
                ref={(node) => { optionRefs.current[index] = node }}
                tabIndex={index === activeIndex ? 0 : -1}
                onFocus={() => setActiveIndex(index)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
                    event.preventDefault()
                    setActiveIndex(moveMenuIndex(index, options.length, event.key))
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    closeMenu(true)
                  }
                }}
                onClick={() => {
                  onChange(option.value)
                  closeMenu(true)
                }}
              >
                <span>
                  {option.icon}
                  {option.label}
                </span>
                {isSelected && <Check size={14} />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function ActionMenu<T extends string>({
  options,
  onSelect,
  ariaLabel,
  trigger,
  className = ''
}: {
  options: readonly ActionMenuOption<T>[]
  onSelect: (value: T) => void
  ariaLabel: string
  trigger: ReactNode
  className?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const menuId = useId()

  function closeMenu(restoreFocus = false): void {
    setOpen(false)
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus())
  }

  function openMenu(index = 0): void {
    setActiveIndex(index)
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    window.requestAnimationFrame(() => optionRefs.current[activeIndex]?.focus())
  }, [activeIndex, open])

  useEffect(() => {
    if (!open) return
    function closeOutside(event: PointerEvent): void {
      if (!rootRef.current?.contains(event.target as Node)) closeMenu()
    }
    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key === 'Escape') closeMenu(true)
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  return (
    <div className={`action-menu ${open ? 'is-open' : ''} ${className}`.trim()} ref={rootRef}>
      <button
        type="button"
        className="action-menu-trigger"
        aria-label={ariaLabel}
        aria-controls={menuId}
        aria-expanded={open}
        aria-haspopup="menu"
        ref={triggerRef}
        onClick={() => open ? closeMenu() : openMenu()}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
            event.preventDefault()
            openMenu(moveMenuIndex(0, options.length, event.key))
          }
        }}
      >
        {trigger}
      </button>
      {open && (
        <div className="action-menu-popover" id={menuId} role="menu" aria-label={ariaLabel}>
          {options.map((option, index) => (
            <button
              type="button"
              role="menuitem"
              className={option.danger ? 'is-danger' : ''}
              key={option.value}
              ref={(node) => { optionRefs.current[index] = node }}
              tabIndex={index === activeIndex ? 0 : -1}
              onFocus={() => setActiveIndex(index)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
                  event.preventDefault()
                  setActiveIndex(moveMenuIndex(index, options.length, event.key))
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  closeMenu(true)
                }
              }}
              onClick={() => {
                closeMenu(true)
                onSelect(option.value)
              }}
            >
              {option.icon}
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

interface SuggestionInputProps {
  value: string
  suggestions: readonly string[]
  onChange: (value: string) => void
  ariaLabel: string
  placeholder?: string
}

export function SuggestionInput({
  value,
  suggestions,
  onChange,
  ariaLabel,
  placeholder
}: SuggestionInputProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const listboxId = useId()
  const normalizedValue = value.trim().toLowerCase()
  const filteredSuggestions = suggestions.filter(
    (suggestion) => !normalizedValue || suggestion.toLowerCase().includes(normalizedValue)
  )
  const visibleSuggestions = filteredSuggestions.length > 0 ? filteredSuggestions : suggestions

  useEffect(() => {
    if (!open) return

    function closeOutside(event: PointerEvent): void {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }

    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  return (
    <div className={`suggestion-input ${open ? 'is-open' : ''}`} ref={rootRef}>
      <input
        value={value}
        placeholder={placeholder}
        role="combobox"
        aria-label={ariaLabel}
        aria-controls={listboxId}
        aria-expanded={open}
        aria-autocomplete="list"
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          onChange(event.target.value)
          setOpen(true)
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setOpen(true)
          }
        }}
      />
      <button
        type="button"
        className="suggestion-input-toggle"
        aria-label={`${ariaLabel}建议`}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="select-menu-popover" id={listboxId} role="listbox" aria-label={`${ariaLabel}建议`}>
          {visibleSuggestions.map((suggestion) => {
            const isSelected = suggestion === value
            return (
              <button
                type="button"
                role="option"
                aria-selected={isSelected}
                className={`select-menu-option ${isSelected ? 'is-selected' : ''}`}
                key={suggestion}
                onClick={() => {
                  onChange(suggestion)
                  setOpen(false)
                }}
              >
                <span>{suggestion}</span>
                {isSelected && <Check size={14} />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
