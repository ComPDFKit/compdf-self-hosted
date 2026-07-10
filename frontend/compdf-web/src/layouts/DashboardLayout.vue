<script setup lang="ts">
import AppSidebar from '@/components/AppSidebar.vue';
import AdminHeader from '@/components/AdminHeader.vue';
</script>

<template>
  <div class="min-h-screen bg-brand-background flex relative">
    <AppSidebar />
    <main class="flex-1 min-w-0 pl-[240px] flex flex-col h-screen overflow-hidden">
      <AdminHeader />
      <section class="flex-1 overflow-y-auto p-8 custom-scrollbar">
        <RouterView v-slot="{ Component }">
          <Transition name="page" mode="out-in">
            <component :is="Component" />
          </Transition>
        </RouterView>
      </section>
    </main>
  </div>
</template>

<style scoped>
.page-enter-active,
.page-leave-active {
  transition: opacity 0.16s ease-out, transform 0.16s ease-out;
}
.page-enter-from {
  opacity: 0;
  transform: translateY(7px);
}
.page-leave-to {
  opacity: 0;
  transform: translateY(-7px);
}
@media (max-width: 768px) {
  main {
    padding-left: 0;
  }
}
</style>
