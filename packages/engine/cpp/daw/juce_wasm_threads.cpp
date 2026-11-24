// juce::Thread on Emscripten's pthreads (daw.wasm only: engine.wasm has no threads). JUCE has
// no WebAssembly version of these, so this is its Linux one without the scheduler settings.
#include <juce_core/juce_core.h>
#include <pthread.h>

namespace juce
{
void JUCE_API juce_threadEntryPoint (void*);

bool Thread::createNativeThread (Priority)
{
    pthread_attr_t attr;
    pthread_attr_init (&attr);
    pthread_attr_setstacksize (&attr, (size_t) jmax ((size_t) 1 << 20, threadStackSize));

    pthread_t handle {};
    const auto ok = pthread_create (&handle, &attr, [] (void* userData) -> void*
    {
        juce_threadEntryPoint (userData);
        return nullptr;
    }, this) == 0;
    pthread_attr_destroy (&attr);

    if (! ok)
        return false;

    pthread_detach (handle);
    threadId = threadHandle = (void*) handle;
    return true;
}

void Thread::killThread()
{
    if (threadHandle != nullptr)
        pthread_cancel ((pthread_t) threadHandle.load());
}




void MemoryMappedFile::openInternal (const File&, AccessMode, bool) {}
MemoryMappedFile::~MemoryMappedFile() {}
} // namespace juce

// JUCE pins threads to cores where it can; a browser has no say in that.
extern "C" int pthread_setaffinity_np (pthread_t, size_t, const cpu_set_t*) { return 0; }
