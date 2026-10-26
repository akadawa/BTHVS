/* Force-included into Lua: fixed hash seed so pairs() order of string keys is identical on all peers. */
#define luai_makeseed(L) 0x5eed1234u
