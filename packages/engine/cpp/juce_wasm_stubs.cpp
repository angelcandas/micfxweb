// JUCE symbols that have no WebAssembly version. The engine runs on the browser's audio
// thread and never starts a thread or maps a file, so these are never reached.
#include <juce_core/juce_core.h>

namespace juce
{
bool Thread::createNativeThread (Priority) { jassertfalse; return false; }
void Thread::killThread() {}
void MemoryMappedFile::openInternal (const File&, AccessMode, bool) {}
MemoryMappedFile::~MemoryMappedFile() {}
} // namespace juce
