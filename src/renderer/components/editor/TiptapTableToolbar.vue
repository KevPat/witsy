<template>
  <Transition name="table-toolbar">
    <ScrollContainer v-if="editor && isInTable" direction="horizontal" :scroll-amount="100">
      <div class="tiptap-table-toolbar">

        <!-- Row Operations -->
        <ButtonIcon
          @click="editor.chain().focus().addRowBefore().run()"
          v-tooltip="{ text: t('playbooks.editor.toolbar.table.addRowAbove'), position: 'bottom' }"
         :label="t('playbooks.editor.toolbar.table.addRowAbove')">
          <AddRowAboveIcon class="custom-icon" />
        </ButtonIcon>
        <ButtonIcon
          @click="editor.chain().focus().addRowAfter().run()"
          v-tooltip="{ text: t('playbooks.editor.toolbar.table.addRowBelow'), position: 'bottom' }"
         :label="t('playbooks.editor.toolbar.table.addRowBelow')">
          <AddRowBelowIcon class="custom-icon" />
        </ButtonIcon>
        <ButtonIcon
          @click="editor.chain().focus().deleteRow().run()"
          v-tooltip="{ text: t('playbooks.editor.toolbar.table.deleteRow'), position: 'bottom' }"
         :label="t('playbooks.editor.toolbar.table.deleteRow')">
          <RemoveRowIcon class="custom-icon" />
        </ButtonIcon>

        <div class="toolbar-separator"></div>

        <!-- Column Operations -->
        <ButtonIcon
          @click="editor.chain().focus().addColumnBefore().run()"
          v-tooltip="{ text: t('playbooks.editor.toolbar.table.addColumnLeft'), position: 'bottom' }"
         :label="t('playbooks.editor.toolbar.table.addColumnLeft')">
          <AddColumnBeforeIcon class="custom-icon" />
        </ButtonIcon>
        <ButtonIcon
          @click="editor.chain().focus().addColumnAfter().run()"
          v-tooltip="{ text: t('playbooks.editor.toolbar.table.addColumnRight'), position: 'bottom' }"
         :label="t('playbooks.editor.toolbar.table.addColumnRight')">
          <AddColumnAfterIcon class="custom-icon" />
        </ButtonIcon>
        <ButtonIcon
          @click="editor.chain().focus().deleteColumn().run()"
          v-tooltip="{ text: t('playbooks.editor.toolbar.table.deleteColumn'), position: 'bottom' }"
         :label="t('playbooks.editor.toolbar.table.deleteColumn')">
          <RemoveColumnIcon class="custom-icon" />
        </ButtonIcon>

        <div class="toolbar-separator"></div>

        <!-- Cell Operations -->
        <ButtonIcon
          @click="editor.chain().focus().mergeCells().run()"
          v-tooltip="{ text: t('playbooks.editor.toolbar.table.mergeCells'), position: 'bottom' }"
         :label="t('playbooks.editor.toolbar.table.mergeCells')">
          <TableCellsMergeIcon :size="16" />
        </ButtonIcon>
        <ButtonIcon
          @click="editor.chain().focus().splitCell().run()"
          v-tooltip="{ text: t('playbooks.editor.toolbar.table.splitCell'), position: 'bottom' }"
         :label="t('playbooks.editor.toolbar.table.splitCell')">
          <TableCellsSplitIcon :size="16" />
        </ButtonIcon>

        <div class="toolbar-separator"></div>

        <!-- Header Operations -->
        <ButtonIcon
          @click="editor.chain().focus().toggleHeaderRow().run()"
          v-tooltip="{ text: t('playbooks.editor.toolbar.table.toggleHeaderRow'), position: 'bottom' }"
         :label="t('playbooks.editor.toolbar.table.toggleHeaderRow')">
          <ToggleHeaderRowIcon class="custom-icon" />
        </ButtonIcon>
        <ButtonIcon
          @click="editor.chain().focus().toggleHeaderColumn().run()"
          v-tooltip="{ text: t('playbooks.editor.toolbar.table.toggleHeaderColumn'), position: 'bottom' }"
         :label="t('playbooks.editor.toolbar.table.toggleHeaderColumn')">
          <ToggleHeaderColumnIcon class="custom-icon" />
        </ButtonIcon>

        <div class="toolbar-separator"></div>

        <!-- Delete Table -->
        <ButtonIcon
          @click="editor.chain().focus().deleteTable().run()"
          v-tooltip="{ text: t('playbooks.editor.toolbar.table.deleteTable'), position: 'bottom' }"
         :label="t('playbooks.editor.toolbar.table.deleteTable')">
          <Trash2Icon :size="16" class="custom-icon" />
        </ButtonIcon>

      </div>
    </ScrollContainer>
  </Transition>
</template>

<script setup lang="ts">
import AddColumnAfterIcon from '@assets/add_column_after.svg?component'
import AddColumnBeforeIcon from '@assets/add_column_before.svg?component'
import AddRowAboveIcon from '@assets/add_row_above.svg?component'
import AddRowBelowIcon from '@assets/add_row_below.svg?component'
import RemoveColumnIcon from '@assets/remove_column.svg?component'
import RemoveRowIcon from '@assets/remove_row.svg?component'
import ToggleHeaderColumnIcon from '@assets/toggle_header_column.svg?component'
import ToggleHeaderRowIcon from '@assets/toggle_header_row.svg?component'
import ButtonIcon from '@components/ButtonIcon.vue'
import ScrollContainer from '@components/ScrollContainer.vue'
import { t } from '@services/i18n'
import type { Editor } from '@tiptap/vue-3'
import { TableCellsMergeIcon, TableCellsSplitIcon, Trash2Icon } from 'lucide-vue-next'

defineProps({
  editor: {
    type: Object as () => Editor,
    required: true,
  },
  isInTable: {
    type: Boolean,
    default: false,
  },
})
</script>

<style scoped>
.tiptap-table-toolbar {
  display: flex;
  flex-wrap: nowrap;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-4);
  background-color: var(--background-color);
  border-top: 1px solid var(--color-outline-variant);
}

.tiptap-table-toolbar .custom-icon {
  width: var(--icon-lg);
  height: var(--icon-lg);
}

.toolbar-separator {
  flex-shrink: 0;
  width: 1px;
  height: 24px;
  background-color: var(--color-outline-variant);
  margin: 0 var(--space-2);
}

/* Table toolbar transition */
.table-toolbar-enter-active,
.table-toolbar-leave-active {
  transition: all 0.2s ease;
}

.table-toolbar-enter-from,
.table-toolbar-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
</style>
