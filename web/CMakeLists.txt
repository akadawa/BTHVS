cmake_minimum_required(VERSION 3.14)
project(CorsixTHWeb C CXX)

# Emscripten build of CorsixTH (Theme Hospital engine) for the browser.
# Invoked through web/build.ps1 (emcmake cmake ...).

set(TP ${CMAKE_CURRENT_SOURCE_DIR}/../third_party)
set(CTH ${TP}/CorsixTH)
set(CTH_SRC ${CTH}/CorsixTH/Src)

# ---------------------------------------------------------------- Lua 5.4 ---
file(GLOB LUA_SOURCES ${TP}/lua/src/*.c)
list(FILTER LUA_SOURCES EXCLUDE REGEX "/(lua|luac)\\.c$")
add_library(lua54 STATIC ${LUA_SOURCES})
target_include_directories(lua54 PUBLIC ${TP}/lua/src)
# Fixed hash seed: string hashes (and therefore pairs() order for string keys)
# must be identical on all multiplayer peers.
target_compile_options(lua54 PRIVATE -O2 -fwasm-exceptions -include ${CMAKE_CURRENT_SOURCE_DIR}/src/lua_seed.h)

# lpeg + lfs (linked statically, see CORSIX_TH_LINK_LUA_MODULES)
file(GLOB LPEG_SOURCES ${TP}/lpeg/lp*.c)
add_library(lpeg STATIC ${LPEG_SOURCES})
target_include_directories(lpeg PRIVATE ${TP}/lua/src)
target_compile_options(lpeg PRIVATE -O2 -fwasm-exceptions)

add_library(lfs STATIC ${TP}/lfs/src/lfs.c)
target_include_directories(lfs PRIVATE ${TP}/lua/src ${TP}/lfs/src)
target_compile_options(lfs PRIVATE -O2 -fwasm-exceptions)

# -------------------------------------------------------------- CorsixTH ----
set(CORSIX_TH_INTERPRETER_NAME CorsixTH.lua)
set(CORSIX_TH_INTERPRETER_PATH /corsixth/CorsixTH.lua)
set(CORSIX_TH_OS unix)
set(CORSIX_TH_ARCH wasm32)
set(CORSIX_TH_USE_SDL_MIXER ON)
set(CORSIX_TH_USE_FREETYPE2 ON)
set(CORSIX_TH_LINK_LUA_MODULES ON)
set(CORSIX_TH_SEARCH_LOCAL_DATADIRS OFF)
set(CORSIX_TH_USE_FFMPEG OFF)
set(WITH_UPDATE_CHECK OFF)
set(CORSIX_TH_FONT "")
configure_file(${CTH_SRC}/config.h.in ${CMAKE_BINARY_DIR}/gen/config.h)

file(GLOB CTH_SOURCES ${CTH_SRC}/*.cpp ${CTH_SRC}/*.c)
list(FILTER CTH_SOURCES EXCLUDE REGEX "/main\\.cpp$")  # lua_main lives in main.cpp, entry point in SrcUnshared
set(CTH_LUA_MAIN ${CTH_SRC}/main.cpp)

add_executable(corsixth
  ${CTH_SOURCES}
  ${CTH_LUA_MAIN}
  ${CMAKE_CURRENT_SOURCE_DIR}/src/web_main.cpp
  ${CTH}/libs/rnc/rnc.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/web_bridge.cpp)

target_include_directories(corsixth PRIVATE
  ${CMAKE_BINARY_DIR}/gen
  ${CTH_SRC}
  ${CTH}/libs/rnc
  ${CTH}/libs
  ${CMAKE_CURRENT_SOURCE_DIR}/src)
set_target_properties(corsixth PROPERTIES CXX_STANDARD 17 CXX_EXTENSIONS OFF)
target_compile_definitions(corsixth PRIVATE CORSIX_TH_WEB=1)
target_compile_options(corsixth PRIVATE -O2 -fwasm-exceptions
  --use-port=sdl2 --use-port=sdl2_mixer --use-port=freetype
  -include ${CMAKE_CURRENT_SOURCE_DIR}/src/web_compat.h)
target_link_libraries(corsixth PRIVATE lua54 lpeg lfs)

# Assets are staged by build.ps1 into build/stage/corsixth and preloaded.
set(STAGE ${CMAKE_CURRENT_SOURCE_DIR}/../build/stage)
target_link_options(corsixth PRIVATE
  -fwasm-exceptions
  --use-port=sdl2 --use-port=sdl2_mixer --use-port=freetype
  -sALLOW_MEMORY_GROWTH=1
  -sINITIAL_MEMORY=268435456
  -sMAXIMUM_MEMORY=2147483648
  -sSTACK_SIZE=5242880
  -sFORCE_FILESYSTEM=1
  -sEXIT_RUNTIME=0
  -sINVOKE_RUN=0
  -sMODULARIZE=1
  -sEXPORT_NAME=createCorsixTH
  "-sEXPORTED_RUNTIME_METHODS=FS,callMain,ccall,cwrap,UTF8ToString,stringToUTF8,lengthBytesUTF8,HEAPU8"
  "-sEXPORTED_FUNCTIONS=_main,_malloc,_free,_th_resize,_th_eval_lua"
  -lidbfs.js
  --preload-file ${STAGE}/corsixth@/corsixth)
