// Single-line text input with the editing keybindings every terminal
// editor has and @inkjs/ui's <TextInput> lacks: word- and line-wise
// deletion and motion. @inkjs/ui only wired single-char backspace and
// arrow-by-one, so Ctrl/Alt+Backspace, Ctrl+W, Ctrl+U, etc. did nothing.
//
// The edit logic lives in ./text-edit.ts (framework-free, unit-tested);
// this wrapper is just React state, key plumbing, and rendering. Ink
// surfaces modifiers as key.ctrl / key.meta (meta === Alt). Ctrl+C and
// Ctrl+D are owned by the app-level useInput (quit / EOF).

import { useEffect, useMemo, useReducer, useRef } from "react";
import type * as React from "react";
import { Text, useInput } from "ink";
import { decide, reduce, type State } from "./text-edit.ts";

/** One <Text> flow: chars, the cursor as an inverted cell, and the
 *  greyed suggestion tail. Mirrors @inkjs/ui's rendering so the bar
 *  looks identical. */
function render(
  value: string,
  cursor: number,
  suggestion: string,
  placeholder: string,
  isDisabled: boolean,
): React.ReactElement {
  if (value.length === 0) {
    if (isDisabled) return <Text>{placeholder ? <Text dimColor>{placeholder}</Text> : ""}</Text>;
    if (placeholder.length > 0) {
      return (
        <Text>
          <Text inverse>{placeholder[0]}</Text>
          <Text dimColor>{placeholder.slice(1)}</Text>
        </Text>
      );
    }
    return <Text inverse> </Text>;
  }

  const spans: React.ReactNode[] = [];
  for (let i = 0; i < value.length; i++) {
    spans.push(
      i === cursor ? <Text key={i} inverse>{value[i]}</Text> : <Text key={i}>{value[i]}</Text>,
    );
  }
  if (suggestion) {
    if (cursor === value.length) {
      spans.push(<Text key="s0" inverse>{suggestion[0]}</Text>);
      spans.push(<Text key="s1" dimColor>{suggestion.slice(1)}</Text>);
    } else {
      spans.push(<Text key="s" dimColor>{suggestion}</Text>);
    }
  } else if (cursor === value.length) {
    spans.push(<Text key="cur" inverse> </Text>);
  }
  return <Text>{spans}</Text>;
}

export function TextInput({
  placeholder = "",
  suggestions,
  isDisabled = false,
  onChange,
  onSubmit,
}: {
  placeholder?: string;
  suggestions?: string[];
  isDisabled?: boolean;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
}): React.ReactElement {
  const [state, dispatch] = useReducer(reduce, { value: "", cursor: 0 } as State);
  const { value, cursor } = state;

  const suggestion = useMemo(() => {
    if (value.length === 0) return "";
    return suggestions?.find((s) => s.startsWith(value))?.slice(value.length) ?? "";
  }, [value, suggestions]);

  const prev = useRef(value);
  useEffect(() => {
    if (value !== prev.current) {
      prev.current = value;
      onChange?.(value);
    }
  }, [value, onChange]);

  useInput(
    (input, key) => {
      const decision = decide(input, key, state);
      if (decision.kind === "submit") {
        onSubmit?.(suggestion ? value + suggestion : value);
      } else if (decision.kind === "action") {
        dispatch(decision.action);
      }
    },
    { isActive: !isDisabled },
  );

  return render(value, cursor, suggestion, placeholder, isDisabled);
}
