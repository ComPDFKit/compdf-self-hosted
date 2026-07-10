<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import type { TooltipContentEmits, TooltipContentProps } from "reka-ui"
import { reactiveOmit } from "@vueuse/core"
import { TooltipContent, TooltipPortal, useForwardPropsEmits } from "reka-ui"
import { cn } from "@/lib/utils"

defineOptions({
  inheritAttrs: false,
})

const props = withDefaults(
  defineProps<TooltipContentProps & { class?: HTMLAttributes["class"] }>(),
  {
    sideOffset: 6,
  },
)
const emits = defineEmits<TooltipContentEmits>()

const delegatedProps = reactiveOmit(props, "class")
const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <TooltipPortal>
    <TooltipContent
      v-bind="{ ...$attrs, ...forwarded }"
      data-slot="tooltip-content"
      :class="cn('z-50 max-w-72 rounded-md bg-slate-800 px-3 py-2 text-xs leading-5 text-white shadow-lg', props.class)"
    >
      <slot />
    </TooltipContent>
  </TooltipPortal>
</template>
