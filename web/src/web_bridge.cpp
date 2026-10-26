/* Emscripten glue: timers, JS bridge for Lua ("web" module). */
#include <emscripten.h>
#include <SDL.h>

#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <vector>

#include "lua.hpp"
#include "web_loop.h"

// ---------------------------------------------------------------- timers ----
namespace {
struct web_timer {
  SDL_TimerID id;
  Uint32 due;
  Uint32 interval;
  SDL_TimerCallback callback;
  void* param;
};
std::vector<web_timer> g_timers;
SDL_TimerID g_next_timer_id = 1;
}  // namespace

extern "C" SDL_TimerID th_web_add_timer(Uint32 interval,
                                        SDL_TimerCallback callback,
                                        void* param) {
  web_timer t;
  t.id = g_next_timer_id++;
  t.interval = interval;
  t.due = SDL_GetTicks() + interval;
  t.callback = callback;
  t.param = param;
  g_timers.push_back(t);
  return t.id;
}

extern "C" SDL_bool th_web_remove_timer(SDL_TimerID id) {
  for (auto it = g_timers.begin(); it != g_timers.end(); ++it) {
    if (it->id == id) {
      g_timers.erase(it);
      return SDL_TRUE;
    }
  }
  return SDL_FALSE;
}

extern "C" void th_web_run_timers(void) {
  if (g_timers.empty()) return;
  Uint32 now = SDL_GetTicks();
  // Callbacks may add / remove timers, so work on ids rather than iterators.
  std::vector<SDL_TimerID> due;
  for (auto& t : g_timers) {
    if (static_cast<Sint32>(now - t.due) >= 0) due.push_back(t.id);
  }
  for (SDL_TimerID id : due) {
    auto it = std::find_if(g_timers.begin(), g_timers.end(),
                           [id](const web_timer& t) { return t.id == id; });
    if (it == g_timers.end()) continue;
    web_timer copy = *it;
    Uint32 next = copy.callback(copy.interval, copy.param);
    // The callback may have removed its own timer.
    it = std::find_if(g_timers.begin(), g_timers.end(),
                      [id](const web_timer& t) { return t.id == id; });
    if (it == g_timers.end()) continue;
    if (next == 0) {
      g_timers.erase(it);
    } else {
      it->interval = next;
      it->due = now + next;
    }
  }
}

// Called from JS when the browser window changed size.
extern "C" EMSCRIPTEN_KEEPALIVE void th_resize(int w, int h) {
  SDL_Window* win = SDL_GetWindowFromID(1);
  if (win != nullptr) SDL_SetWindowSize(win, w, h);
}

// ------------------------------------------------------------- JS bridge ----
EM_JS(char*, th_js_call, (const char* cmd, const char* arg), {
  var c = UTF8ToString(cmd), a = UTF8ToString(arg);
  var r = (Module.thBridge ? Module.thBridge(c, a) : null);
  if (r === null || r === undefined) return 0;
  r = String(r);
  var n = lengthBytesUTF8(r) + 1;
  var p = _malloc(n);
  stringToUTF8(r, p, n);
  return p;
});

EM_JS(double, th_js_now, (), { return performance.now(); });

EM_JS(void, th_js_fatal, (const char* msg), {
  var m = UTF8ToString(msg);
  if (Module.thFatal) Module.thFatal(m); else console.error(m);
});

void th_web_fatal(const char* msg) { th_js_fatal(msg); }

namespace {

// web.call(cmd [, arg]) -> string | nil
int l_web_call(lua_State* L) {
  const char* cmd = luaL_checkstring(L, 1);
  const char* arg = luaL_optstring(L, 2, "");
  char* r = th_js_call(cmd, arg);
  if (r == nullptr) {
    lua_pushnil(L);
  } else {
    lua_pushstring(L, r);
    std::free(r);
  }
  return 1;
}

// web.now() -> milliseconds (double, monotonic)
int l_web_now(lua_State* L) {
  lua_pushnumber(L, th_js_now());
  return 1;
}

const luaL_Reg weblib[] = {
    {"call", l_web_call}, {"now", l_web_now}, {nullptr, nullptr}};

}  // namespace

int luaopen_web(lua_State* L) {
  lua_newtable(L);
  luaL_setfuncs(L, weblib, 0);
  return 1;
}
