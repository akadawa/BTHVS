/* Compatibility shims for building CorsixTH with Emscripten (force-included
   into every translation unit of the "corsixth" target). */
#ifndef CORSIX_TH_WEB_COMPAT_H_
#define CORSIX_TH_WEB_COMPAT_H_

#ifdef __cplusplus
#include <SDL.h>

extern "C" {
// SDL timers need threads, which are not available in the browser build.
// These replacements are polled once per main loop iteration instead.
SDL_TimerID th_web_add_timer(Uint32 interval, SDL_TimerCallback callback,
                             void* param);
SDL_bool th_web_remove_timer(SDL_TimerID id);
void th_web_run_timers(void);
}

#define SDL_AddTimer th_web_add_timer
#define SDL_RemoveTimer th_web_remove_timer

#endif  // __cplusplus
#endif  // CORSIX_TH_WEB_COMPAT_H_
