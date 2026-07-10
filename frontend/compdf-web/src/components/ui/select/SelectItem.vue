<script setup lang="ts">
import type { SelectItemEmits, SelectItemProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { CheckIcon } from "@radix-icons/vue"
import { reactiveOmit } from "@vueuse/core"
import {
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  useForwardPropsEmits,
} from "reka-ui"
import { cn } from "@/lib/utils"

const props = defineProps<SelectItemProps & { class?: HTMLAttributes["class"] }>()
const emits = defineEmits<SelectItemEmits>()

const delegatedProps = reactiveOmit(props, "class")
const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <SelectItem
    v-bind="forwarded"
    data-slot="select-item"
    :class="cn('focus:bg-accent focus:text-accent-foreground relative flex w-full cursor-default select-none items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-hidden data-[disabled]:pointer-events-none data-[disabled]:opacity-50', props.class)"
  >
    <span class="absolute right-2 flex size-3.5 items-center justify-center">
      <SelectItemIndicator>
        <CheckIcon class="size-4" />
      </SelectItemIndicator>
    </span>
    <SelectItemText>
      <slot />
    </SelectItemText>
  </SelectItem>
</template>
