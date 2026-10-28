/* Browser entry point for CorsixTH v0.70.2.
 *
 * In CorsixTH v0.70+, lua_init() initializes TheApp and returns directly to
 * C++, where mainloop(L) registers the non-blocking state driven by
 * requestAnimationFrame via th_web_loop_step() (see sdl_core.cpp).
 */
#include "config.h"

#include <emscripten.h>
#include <SDL.h>
#include <SDL_mixer.h>

#include <cstdio>

#include "lua.hpp"
#include "main.h"
#include "sdl_core.h"
#include "th_lua.h"
#include "web_loop.h"

EM_JS(void, th_js_exit, (int restart), {
  if (Module.thExit) Module.thExit(restart != 0);
});

namespace {

lua_State* g_L = nullptr;

void frame_cb() { th_web_loop_step(); }

}  // namespace

lua_State* th_web_main_state() { return g_L; }

void th_web_loop_finished() {
  emscripten_cancel_main_loop();
  bool restart = false;
  if (g_L != nullptr) {
    lua_getfield(g_L, LUA_REGISTRYINDEX, "_RESTART");
    restart = lua_toboolean(g_L, -1) != 0;
    lua_pop(g_L, 1);
    lua_close(g_L);
    g_L = nullptr;
  }
  while (Mix_QuerySpec(nullptr, nullptr, nullptr)) {
    Mix_CloseAudio();
  }
  SDL_Quit();
  th_js_exit(restart ? 1 : 0);
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

  lua_pushcfunction(g_L, lua_stacktrace);
  lua_pushcfunction(g_L, lua_init);
  lua_checkstack(g_L, argc + 4);
  for (int i = 0; i < argc; ++i) {
    lua_pushstring(g_L, argv[i]);
  }
  if (lua_pcall(g_L, argc, 0, 1) != 0) {
    const char* err = lua_tostring(g_L, -1);
    std::fprintf(stderr, "%s\n", err ? err : "unknown startup error");
    std::fflush(stderr);
    th_web_fatal(err ? err : "unknown startup error");
    return 1;
  }
  lua_settop(g_L, 0);

  mainloop(g_L);
  emscripten_set_main_loop(frame_cb, 0, 1);
  return 0;
}
