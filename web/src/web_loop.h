#ifndef CORSIX_TH_WEB_LOOP_H_
#define CORSIX_TH_WEB_LOOP_H_

#include "lua.hpp"

// Implemented in web_bridge.cpp
int luaopen_web(lua_State* L);
void th_web_fatal(const char* msg);

// Implemented in sdl_core.cpp: runs one browser animation frame worth of the
// CorsixTH main loop (events, timer ticks, frame drawing).
void th_web_loop_step();

// Implemented in web_main.cpp: the main Lua state.
lua_State* th_web_main_state();

// Implemented in web_main.cpp: called by th_web_loop_step when SDL_QUIT is
// received (e.g. App:exit(), App:abandon(), App:reset()).
void th_web_loop_finished();

#endif  // CORSIX_TH_WEB_LOOP_H_
