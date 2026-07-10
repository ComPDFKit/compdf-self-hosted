<script setup lang="ts">
import type { SelectTriggerProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { ChevronDownIcon } from "@radix-icons/vue"
import { reactiveOmit } from "@vueuse/core"
import {
  SelectIcon,
  SelectTrigger,
  useForwardProps,
} from "reka-ui"
import { cn } from "@/lib/utils"

const props = defineProps<SelectTriggerProps & { class?: HTMLAttributes["class"] }>()

const delegatedProps = reactiveOmit(props, "class")
const forwardedProps = useForwardProps(delegatedProps)
</script>

<template>
  <SelectTrigger
    v-bind="forwardedProps"
    data-slot="select-trigger"
    :class="cn('border-input data-[placeholder]:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive flex h-10 w-80 max-w-full items-center justify-between gap-2 rounded-md border bg-white px-3 py-2 text-left text-base whitespace-nowrap shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1', props.class)"
  >
    <slot />
    <SelectIcon as-child>
      <ChevronDownIcon class="size-4 opacity-60" />
    </SelectIcon>
  </SelectTrigger>
</template>
