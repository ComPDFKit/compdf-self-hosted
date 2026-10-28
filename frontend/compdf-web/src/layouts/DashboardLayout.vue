<script setup lang="ts">
import { ref } from 'vue';
import AppSidebar from '@/components/AppSidebar.vue';
import AdminHeader from '@/components/AdminHeader.vue';

const mobileNavigationOpen = ref(false);
</script>

<template>
  <div class="min-h-screen bg-brand-background flex relative">
    <button
      v-if="mobileNavigationOpen"
      type="button"
      class="fixed inset-0 z-30 bg-black/35 md:hidden"
      aria-label="Close navigation"
      @click="mobileNavigationOpen = false"
    />
    <AppSidebar :mobile-open="mobileNavigationOpen" @navigate="mobileNavigationOpen = false" />
    <main class="flex h-screen min-w-0 flex-1 flex-col overflow-hidden pl-0 md:pl-[240px]">
      <AdminHeader @toggle-navigation="mobileNavigationOpen = !mobileNavigationOpen" />
      <section class="custom-scrollbar flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
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
</style>
