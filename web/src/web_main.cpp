/* Browser entry point for CorsixTH.
 *
 * The native build calls lua_pcall() on a blocking script. A browser cannot
 * block, so the whole Lua program runs inside one coroutine; SDL.mainloop()
 * yields it (see sdl_core.cpp) and requestAnimationFrame drives the event
 * dispatcher. When the dispatcher ends, the coroutine is resumed again.
 */
#include "config.h"

#include <emscripten.h>
#include <SDL.h>
#ifdef CORSIX_TH_USE_SDL_MIXER
#include <SDL_mixer.h>
#endif

#include <cstdio>
#include <string>

#include "lua.hpp"
#include "main.h"
#include "th_lua.h"
#include "web_loop.h"

EM_JS(void, th_js_exit, (int restart), {
  if (Module.thExit) Module.thExit(restart != 0);
});

namespace {

lua_State* g_L = nullptr;
lua_State* g_T = nullptr;

void report_error(lua_State* T) {
  const char* msg = lua_tostring(T, -1);
  if (msg == nullptr) msg = "(non-string error object)";
  luaL_traceback(g_L, T, msg, 0);
  const char* tb = lua_tostring(g_L, -1);
  std::fprintf(stderr, "An error has occurred in CorsixTH:\n%s\n", tb);
  std::fflush(stderr);
  th_web_fatal(tb);
  lua_pop(g_L, 1);
}

void on_script_end(int status) {
  emscripten_cancel_main_loop();
  if (status != LUA_OK) {
    report_error(g_T);
    return;
  }
  lua_getfield(g_L, LUA_REGISTRYINDEX, "_RESTART");
  bool restart = lua_toboolean(g_L, -1) != 0;
  lua_pop(g_L, 1);
  th_js_exit(restart ? 1 : 0);
}

void resume_script(int nargs) {
  int nres = 0;
  int status = luaT_resume(g_T, g_L, nargs, &nres);
  if (status == LUA_YIELD) return;  // SDL.mainloop() registered itself
  on_script_end(status);
}

void frame_cb() { th_web_loop_step(); }

}  // namespace

lua_State* th_web_main_state() { return g_L; }

void th_web_loop_finished(lua_State* caller, int nresults) {
  (void)caller;
  resume_script(nresults);
}

int main(int argc, char** argv) {
  // Keyboard events only from the game canvas, so that HTML inputs (chat)
  // do not leak keystrokes into the game.
  SDL_SetHint("SDL_EMSCRIPTEN_KEYBOARD_ELEMENT", "#canvas");
  g_L = luaL_newstate();
  if (g_L == nullptr) {
    th_web_fatal("Cannot open Lua state");
    return 1;
  }
  lua_atpanic(g_L, lua_panic);
  luaL_openlibs(g_L);
  lua_settop(g_L, 0);

  g_T = lua_newthread(g_L);
  lua_setfield(g_L, LUA_REGISTRYINDEX, "web_main_thread");

  lua_pushcfunction(g_L, lua_stacktrace);
  lua_pushcfunction(g_L, lua_main_no_eval);
  lua_checkstack(g_L, argc + 4);
  for (int i = 0; i < argc; ++i) {
    lua_pushstring(g_L, argv[i]);
  }
  if (lua_pcall(g_L, argc, LUA_MULTRET, 1) != 0) {
    const char* err = lua_tostring(g_L, -1);
    std::fprintf(stderr, "%s\n", err ? err : "unknown startup error");
    th_web_fatal(err ? err : "unknown startup error");
    return 1;
  }
  // Stack is now: [msgh, chunk, args...]; run it inside the coroutine.
  int n = lua_gettop(g_L) - 1;
  lua_checkstack(g_T, n + 4);
  lua_xmove(g_L, g_T, n);
  int nres = 0;
  int status = luaT_resume(g_T, g_L, n - 1, &nres);
  if (status != LUA_YIELD) {
    on_script_end(status);
    return 0;
  }
  emscripten_set_main_loop(frame_cb, 0, 1);
  return 0;
}
