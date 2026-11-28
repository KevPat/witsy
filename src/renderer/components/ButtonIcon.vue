<template>
  <button type="button" class="button-icon" :aria-label="accessibleLabel" @click="onClick">
    <slot />
  </button>
</template>

<script setup lang="ts">

import { computed, useAttrs, useSlots, type VNode } from 'vue'

const emit = defineEmits(['click'])
const props = defineProps<{
  label?: string
}>()
const attrs = useAttrs()
const slots = useSlots()

const vnodeLabel = (vnode: VNode): string => {
  if (typeof vnode.children === 'string' && vnode.children.trim()) {
    return vnode.children.trim()
  }
  const component = (typeof vnode.type === 'object' || typeof vnode.type === 'function')
    ? vnode.type as { name?: string; __name?: string }
    : null
  const name = component?.name || component?.__name
  if (name) return name.replace(/Icon$/, '').replace(/([a-z])([A-Z])/g, '$1 $2')

  // Lucide icons are anonymous functional components. Their rendered vnode
  // carries the icon name even though the component function does not.
  if (typeof vnode.type === 'function') {
    const render = vnode.type as unknown as (
      props: Record<string, unknown>,
      context: Record<string, unknown>,
    ) => VNode
    const rendered = render(vnode.props ?? {}, {
      attrs: {},
      emit: (): void => undefined,
      expose: (): void => undefined,
      slots: {},
    })
    const renderedName = (rendered.props as { name?: string } | null)?.name
    if (renderedName) {
      const label = renderedName.replaceAll('-', ' ')
      return label.charAt(0).toUpperCase() + label.slice(1)
    }
  }

  return ''
}

const accessibleLabel = computed(() => {
  const explicit = props.label || attrs['aria-label'] || attrs.title
  if (typeof explicit === 'string' && explicit.trim()) return explicit
  return slots.default?.().map(vnodeLabel).filter(Boolean).join(' ') || undefined
})

function onClick(event: MouseEvent) {
  emit('click', event)
}

</script>

<style scoped>

.button-icon {
  flex: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.5rem;
  margin: 0;
  border: none;
  background: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background-color 0.15s ease;

  &:deep() svg {
    flex-shrink: 0;
    color: var(--chatarea-toolbar-icon-color);
    width: var(--icon-md);
    height: var(--icon-md);
  }

  &:hover {
    background-color: var(--color-surface-low);
  }

  &:active {
    background-color: var(--color-surface-high);
  }

  &:focus {
    outline: none;
  }

  &:focus-visible {
    outline: 2px solid var(--color-focus);
    outline-offset: 2px;
  }
}

</style>
