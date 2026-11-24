// daw.wasm's host: the desktop app's PluginProcessor (in DAW mode) and DawBridge, run by a Web
// Worker in place of the standalone app and its WebView.
//
// Threads:
// - The worker's own thread is JUCE's message thread. The worker's JS calls
//   micfx_daw_dispatch() every few milliseconds (posted messages, timers) and micfx_daw_tick()
//   30 times a second (the editor's timer: DawBridge::tick).
// - The audio thread (AudioPump) renders 128-frame blocks ahead of the page's AudioWorklet. The
//   two share rings in the wasm memory (a SharedArrayBuffer): the worklet reads the output ring
//   and writes the microphone into the input ring; neither side ever waits for the other.
// - The desktop's background jobs (Auto Mix, exports, key detection...) run on pthreads.
//
// The page calls native functions by name with JSON arguments (micfx_daw_call); answers and
// events come back through the JS functions on Module (onDawComplete, onDawEvent...), set by
// apps/daw/src/engine-worker.ts.
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <emscripten/emscripten.h>
#include <emscripten/wasmfs.h>

#include "PluginProcessor.h"
#include "DawBridge.h"
#include "Presets.h"
#include "FactoryChains.h"

namespace juce { int wasmDispatchMessages (int maxMessages); }

EM_JS (void, micfx_js_complete, (int callId, const char* json), {
    Module.onDawComplete(callId, UTF8ToString(json));
});
EM_JS (void, micfx_js_event, (const char* name, const char* json), {
    Module.onDawEvent(UTF8ToString(name), UTF8ToString(json));
});
EM_JS (void, micfx_js_chooser, (int id, const char* json), {
    Module.onDawChooser(id, UTF8ToString(json));
});
EM_JS (void, micfx_js_clipboard, (const char* text), {
    Module.onDawClipboard(UTF8ToString(text));
});

namespace
{
juce::String toJson (const juce::var& v)
{
    return juce::JSON::toString (v, juce::JSON::FormatOptions{}.withSpacing (juce::JSON::Spacing::none).withMaxDecimalPlaces (6));
}

//==============================================================================
// A ring of interleaved stereo (or N-channel) frames in the shared memory. One writer, one
// reader; positions only grow (frames, wrapping at 2^31 is far away: 12 hours at 48 kHz).
struct Ring
{
    // Read by the worklet as Int32Array at `header` (positions) and Float32Array at `data`.
    alignas (16) std::atomic<int32_t> write { 0 };
    std::atomic<int32_t> read { 0 };
    int32_t capacity = 0; // frames
    int32_t channels = 0;
    std::vector<float> data;

    void init (int frames, int numChannels)
    {
        capacity = frames;
        channels = numChannels;
        data.assign ((size_t) (frames * numChannels), 0.0f);
    }

    int available() const noexcept { return write.load() - read.load(); }
    int space() const noexcept     { return capacity - available(); }
};

//==============================================================================
class AudioPump final : public juce::Thread
{
public:
    AudioPump (PluginProcessor& p, int block) : juce::Thread ("MicFX audio"), processor (p), blockSize (block)
    {
        buffer.setSize (PluginProcessor::maxAppInputs, blockSize);
    }

    ~AudioPump() override { stopThread (2000); }

    Ring output, input;
    std::atomic<int> targetFrames { 1024 }; // how far ahead of the worklet the engine renders
    std::atomic<int> inputChannels { 2 };   // the microphone's channels in the input ring
    std::atomic<int> underruns { 0 };
    std::atomic<double> loadAverage { 0.0 };
    std::atomic<bool> paused { false };

    // MIDI from the page (Web MIDI): queued here, handed to the next block.
    void addMidi (const juce::MidiMessage& m)
    {
        const juce::SpinLock::ScopedLockType sl (midiLock);
        pendingMidi.addEvent (m, 0);
    }

private:
    void run() override
    {
        while (! threadShouldExit())
        {
            if (paused.load() || output.space() < blockSize || output.available() >= targetFrames.load())
            {
                juce::Thread::sleep (1);
                continue;
            }

            renderOne();
        }
    }

    void renderOne()
    {
        const auto started = juce::Time::getMillisecondCounterHiRes();
        juce::ScopedNoDenormals noDenormals;

        // The microphone (or the interface's inputs), as far as the worklet has written it.
        buffer.clear();
        const auto inChannels = juce::jmin (input.channels, buffer.getNumChannels());
        if (inChannels > 0 && input.available() >= blockSize)
        {
            const auto start = input.read.load();
            for (int i = 0; i < blockSize; ++i)
            {
                const auto frame = (size_t) ((start + i) % input.capacity) * (size_t) input.channels;
                for (int ch = 0; ch < inChannels; ++ch)
                    buffer.setSample (ch, i, input.data[frame + (size_t) ch]);
            }
            input.read.store (start + blockSize);
        }
        else if (input.available() > 0 && input.available() < blockSize)
        {
            // Not enough yet: the input waits for the next block (the output never does).
        }

        {
            const juce::SpinLock::ScopedLockType sl (midiLock);
            midi.swapWith (pendingMidi);
            pendingMidi.clear();
        }

        juce::AudioBuffer<float> view (buffer.getArrayOfWritePointers(), buffer.getNumChannels(), blockSize);
        processor.processBlock (view, midi);
        midi.clear();

        const auto start = output.write.load();
        for (int i = 0; i < blockSize; ++i)
        {
            const auto frame = (size_t) ((start + i) % output.capacity) * (size_t) output.channels;
            for (int ch = 0; ch < output.channels; ++ch)
                output.data[frame + (size_t) ch] = view.getSample (juce::jmin (ch, view.getNumChannels() - 1), i);
        }
        output.write.store (start + blockSize);

        const auto took = juce::Time::getMillisecondCounterHiRes() - started;
        const auto budget = 1000.0 * blockSize / juce::jmax (1.0, processor.getSampleRate());
        loadAverage.store (loadAverage.load() * 0.95 + 0.05 * (took / budget));
    }

    PluginProcessor& processor;
    const int blockSize;
    juce::AudioBuffer<float> buffer;
    juce::MidiBuffer midi, pendingMidi;
    juce::SpinLock midiLock;
};

//==============================================================================
struct Host
{
    Host (double sampleRate, int blockSize)
        : settings (settingsOptions())
    {
        processor = std::make_unique<PluginProcessor>();
        processor->setRateAndBufferSizeDetails (sampleRate, blockSize);
        processor->prepareToPlay (sampleRate, blockSize);

        bridge = std::make_unique<DawBridge> (*processor, settings,
                                              [] (const juce::Identifier& event, const juce::var& payload)
                                              { micfx_js_event (event.toString().toRawUTF8(), toJson (payload).toRawUTF8()); },
                                              [this] { return (juce::int64) roundTripLatency.load(); });
        bridge->inputNames = [this]
        {
            juce::StringArray names;
            for (int i = 0; i < pump->inputChannels.load(); ++i)
                names.add ("Input " + juce::String (i + 1));
            return names;
        };

        pump = std::make_unique<AudioPump> (*processor, blockSize);
        pump->output.init (8192, 2);
        pump->input.init (8192, PluginProcessor::maxAppInputs);
        pump->startThread (juce::Thread::Priority::highest);
    }

    ~Host()
    {
        pump.reset();
        bridge.reset();
        processor->releaseResources();
        processor.reset();
    }

    static juce::PropertiesFile::Options settingsOptions()
    {
        juce::PropertiesFile::Options options;
        options.applicationName = "MicFX";
        options.filenameSuffix  = ".settings";
        options.folderName      = "MicFX";
        return options;
    }

    // The native functions the DAW screen calls (the desktop's PluginEditor has the same).
    void call (int callId, const juce::String& name, const juce::var& args)
    {
        auto complete = [callId] (const juce::var& result) { micfx_js_complete (callId, toJson (result).toRawUTF8()); };
        const auto arg = [&args] (int i) { return args.isArray() && i < args.size() ? args[i] : juce::var(); };
        const auto text = [&arg] (int i) { return arg (i).toString(); };

        if (name == "daw")
        {
            bridge->handle (text (0), arg (1).isObject() ? arg (1) : juce::var (new juce::DynamicObject()), complete);
        }
        else if (name == "getParameterDefaults")
        {
            auto* defaults = new juce::DynamicObject();
            for (auto* parameter : processor->getParameters())
                if (auto* ranged = dynamic_cast<juce::RangedAudioParameter*> (parameter))
                    defaults->setProperty (ranged->getParameterID(), ranged->convertFrom0to1 (ranged->getDefaultValue()));
            complete (juce::var (defaults));
        }
        else if (name == "getParameterInfo")
        {
            auto* info = new juce::DynamicObject();
            for (auto* parameter : processor->getParameters())
            {
                auto* ranged = dynamic_cast<juce::RangedAudioParameter*> (parameter);
                if (ranged == nullptr)
                    continue;

                auto* entry = new juce::DynamicObject();
                const auto& range = ranged->getNormalisableRange();
                entry->setProperty ("name", ranged->getName (100));
                entry->setProperty ("min", range.start);
                entry->setProperty ("max", range.end);
                entry->setProperty ("skew", range.skew);
                entry->setProperty ("step", range.interval);
                entry->setProperty ("label", ranged->getLabel());
                entry->setProperty ("default", ranged->convertFrom0to1 (ranged->getDefaultValue()));

                if (auto* choice = dynamic_cast<juce::AudioParameterChoice*> (parameter))
                {
                    juce::Array<juce::var> choices;
                    for (const auto& c : choice->choices)
                        choices.add (c);
                    entry->setProperty ("choices", choices);
                }

                if (dynamic_cast<juce::AudioParameterBool*> (parameter) != nullptr)
                    entry->setProperty ("bool", true);

                info->setProperty (ranged->getParameterID(), juce::var (entry));
            }
            complete (juce::var (info));
        }
        else if (name == "getPresets")
        {
            juce::Array<juce::var> list;
            for (const auto& preset : getPresets())
            {
                auto* entry = new juce::DynamicObject();
                entry->setProperty ("name", preset.name);
                entry->setProperty ("category", preset.category);
                list.add (juce::var (entry));
            }
            complete (list);
        }
        else if (name == "uiPref")
        {
            const auto key = "ui." + text (0).retainCharacters ("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_");
            if (args.size() > 1)
                settings.setValue (key, text (1).substring (0, 20000));
            complete (settings.getValue (key));
        }
        else if (name == "library")
        {
            library (args, complete);
        }
        else if (name == "loadPreset")
        {
            processor->setCurrentProgram ((int) arg (0));
            complete (processor->getCurrentProgram());
        }
        else
        {
            complete ({});
        }
    }

    void library (const juce::var& args, const std::function<void (const juce::var&)>& complete)
    {
        auto& lib = processor->getLibrary();
        const auto action = args.size() > 0 ? args[0].toString() : juce::String();
        const auto text = [&args] (int i) { return args.size() > i ? args[i].toString() : juce::String(); };
        const auto answer = [&complete] (const juce::String& error)
        {
            auto* result = new juce::DynamicObject();
            result->setProperty ("ok", error.isEmpty());
            if (error.isNotEmpty())
                result->setProperty ("error", error);
            complete (juce::var (result));
        };

        if (action == "effects")            complete (lib.listEffects());
        else if (action == "chains")        complete (lib.listChains());
        else if (action == "saveEffect")    answer (lib.saveEffect (text (1), text (2), args.size() > 3 ? args[3] : juce::var()));
        else if (action == "deleteEffect")  answer (lib.deleteEffect (text (1), text (2)) ? juce::String() : "It's already gone.");
        else if (action == "renameEffect")  answer (lib.renameEffect (text (1), text (2), text (3)));
        else if (action == "getDefault")    complete (lib.getDefault (text (1)));
        else if (action == "setDefault")    answer (lib.setDefault (text (1), args.size() > 2 ? args[2] : juce::var()));
        else if (action == "clearDefault")  answer (lib.clearDefault (text (1)) ? juce::String() : "There was no default.");
        else if (action == "factoryChains") complete (factory::listChains());
        else if (action == "deleteChain")   answer (lib.deleteChain (text (1)) ? juce::String() : "It's already gone.");
        else if (action == "renameChain")   answer (lib.renameChain (text (1), text (2)));
        else if (action == "import")        complete (lib.importOnce (text (1)));
        else                                answer ("Unknown library action " + action);
    }

    juce::PropertiesFile settings;
    std::unique_ptr<PluginProcessor> processor;
    std::unique_ptr<DawBridge> bridge;
    std::unique_ptr<AudioPump> pump;
    std::atomic<int> roundTripLatency { 0 };
};

std::unique_ptr<Host> host;

// The file choosers waiting for the page, by id.
std::map<int, juce::FileChooser*> choosers;
int nextChooser = 1;

juce::JUCEApplicationBase* makeNoApp() { return nullptr; }
} // namespace

//==============================================================================
namespace juce::web
{
void requestChooser (FileChooser& chooser, const String& title, const File& start, const String& patterns, int flags)
{
    const auto id = nextChooser++;
    choosers[id] = &chooser;

    auto* request = new DynamicObject();
    request->setProperty ("title", title);
    request->setProperty ("start", start.getFullPathName());
    request->setProperty ("patterns", patterns);
    request->setProperty ("save", (flags & FileBrowserComponent::saveMode) != 0);
    request->setProperty ("folders", (flags & FileBrowserComponent::canSelectDirectories) != 0);
    request->setProperty ("files", (flags & FileBrowserComponent::canSelectFiles) != 0 || (flags & FileBrowserComponent::canSelectDirectories) == 0);
    request->setProperty ("multiple", (flags & FileBrowserComponent::canSelectMultipleItems) != 0);
    micfx_js_chooser (id, toJson (var (request)).toRawUTF8());
}

void cancelChooser (FileChooser& chooser)
{
    for (auto it = choosers.begin(); it != choosers.end();)
        it = it->second == &chooser ? choosers.erase (it) : std::next (it);
}

void copyToClipboard (const String& text) { micfx_js_clipboard (text.toRawUTF8()); }
} // namespace juce::web

//==============================================================================
extern "C"
{
// Mounts the browser's private storage (OPFS) as the home folder, so projects, the library and
// settings stay between visits. Falls back to memory when the browser has no OPFS.
EMSCRIPTEN_KEEPALIVE int micfx_daw_mount (int useOpfs)
{
    int persistent = 0;
    if (useOpfs)
    {
        mkdir ("/home", 0777);
        if (auto backend = wasmfs_create_opfs_backend())
        {
            const auto result = wasmfs_create_directory ("/home/web", 0777, backend);
            persistent = result == 0 ? 1 : 0;
            if (! persistent)
                printf ("MicFX DAW: the browser's storage couldn't be mounted (%d)\n", result);
        }
    }
    if (! persistent)
        mkdir ("/home/web", 0777);

    setenv ("HOME", "/home/web", 1);
    setenv ("TMPDIR", "/tmp", 1);
    for (auto* folder : { "/home/web/Documents", "/home/web/Music", "/home/web/.config", "/tmp" })
        mkdir (folder, 0777);
    return persistent;
}

EMSCRIPTEN_KEEPALIVE int micfx_daw_create (double sampleRate, int blockSize)
{
    juce::JUCEApplicationBase::createInstance = &makeNoApp; // isStandaloneApp(): the app's DAW mode
    juce::MessageManager::getInstance()->setCurrentThreadAsMessageThread();
    host = std::make_unique<Host> (sampleRate, blockSize);
    return 1;
}

EMSCRIPTEN_KEEPALIVE void micfx_daw_destroy() { host.reset(); }

EMSCRIPTEN_KEEPALIVE int micfx_daw_dispatch() { return juce::wasmDispatchMessages (256); }

EMSCRIPTEN_KEEPALIVE void micfx_daw_tick()
{
    if (host != nullptr)
        host->bridge->tick();
}

// A native function: name and its arguments as a JSON array. Answers with onDawComplete(callId).
EMSCRIPTEN_KEEPALIVE void micfx_daw_call (int callId, const char* name, const char* argsJson)
{
    if (host == nullptr)
    {
        micfx_js_complete (callId, "null");
        return;
    }
    host->call (callId, juce::String::fromUTF8 (name), juce::JSON::parse (juce::String::fromUTF8 (argsJson)));
}

// The page's answer to a chooser: picked paths, one per line (empty: cancelled).
EMSCRIPTEN_KEEPALIVE void micfx_daw_chooser_result (int id, const char* paths)
{
    const auto it = choosers.find (id);
    if (it == choosers.end())
        return;

    auto* chooser = it->second;
    choosers.erase (it);

    juce::Array<juce::File> files;
    for (const auto& line : juce::StringArray::fromLines (juce::String::fromUTF8 (paths)))
        if (line.isNotEmpty())
            files.add (juce::File (line));
    chooser->finish (files);
}

// The rings the worklet shares: [outWrite, outRead, outCapacity, outChannels, outData,
//                                inWrite, inRead, inCapacity, inChannels, inData] as addresses/values.
EMSCRIPTEN_KEEPALIVE void micfx_daw_rings (int32_t* out)
{
    auto& o = host->pump->output;
    auto& i = host->pump->input;
    out[0] = (int32_t) reinterpret_cast<intptr_t> (&o.write);
    out[1] = (int32_t) reinterpret_cast<intptr_t> (&o.read);
    out[2] = o.capacity;
    out[3] = o.channels;
    out[4] = (int32_t) reinterpret_cast<intptr_t> (o.data.data());
    out[5] = (int32_t) reinterpret_cast<intptr_t> (&i.write);
    out[6] = (int32_t) reinterpret_cast<intptr_t> (&i.read);
    out[7] = i.capacity;
    out[8] = i.channels;
    out[9] = (int32_t) reinterpret_cast<intptr_t> (i.data.data());
}

// How far ahead the engine renders (frames), the inputs the page records from, the measured
// round trip (frames, for lining up recordings) and whether the engine runs.
EMSCRIPTEN_KEEPALIVE void micfx_daw_audio_settings (int targetFrames, int inputChannels, int roundTripFrames, int paused)
{
    if (host == nullptr)
        return;
    host->pump->targetFrames = juce::jlimit (128, host->pump->output.capacity - 256, targetFrames);
    host->pump->inputChannels = juce::jlimit (0, PluginProcessor::maxAppInputs, inputChannels);
    host->roundTripLatency = roundTripFrames;
    host->pump->paused = paused != 0;
}

// -> the engine's load (0..1 of the real-time budget, averaged) * 1000
EMSCRIPTEN_KEEPALIVE int micfx_daw_load() { return host == nullptr ? 0 : (int) (host->pump->loadAverage.load() * 1000.0); }

EMSCRIPTEN_KEEPALIVE void micfx_daw_midi (int status, int data1, int data2)
{
    if (host != nullptr)
        host->pump->addMidi (juce::MidiMessage ((juce::uint8) status, (juce::uint8) data1, (juce::uint8) data2));
}

// Files for the page (the chooser, downloads, imports), through JUCE so they see the same
// file system the DAW does. Returned buffers are the caller's to free.
EMSCRIPTEN_KEEPALIVE char* micfx_daw_list (const char* path)
{
    juce::Array<juce::var> entries;
    for (const auto& entry : juce::RangedDirectoryIterator (juce::File (juce::String::fromUTF8 (path)), false, "*",
                                                            juce::File::findFilesAndDirectories))
    {
        auto* item = new juce::DynamicObject();
        item->setProperty ("name", entry.getFile().getFileName());
        item->setProperty ("folder", entry.isDirectory());
        item->setProperty ("size", (double) entry.getFileSize());
        item->setProperty ("modified", (double) entry.getModificationTime().toMilliseconds());
        entries.add (juce::var (item));
    }
    const auto json = toJson (entries);
    auto* out = (char*) malloc ((size_t) json.getNumBytesAsUTF8() + 1);
    memcpy (out, json.toRawUTF8(), (size_t) json.getNumBytesAsUTF8() + 1);
    return out;
}

EMSCRIPTEN_KEEPALIVE int micfx_daw_write (const char* path, const void* data, int size)
{
    const juce::File file (juce::String::fromUTF8 (path));
    file.getParentDirectory().createDirectory();
    return file.replaceWithData (data, (size_t) size) ? 1 : 0;
}

// -> the file's bytes (malloc'd), and its size in *size (-1 when it can't be read).
EMSCRIPTEN_KEEPALIVE void* micfx_daw_read (const char* path, int* size)
{
    juce::MemoryBlock block;
    if (! juce::File (juce::String::fromUTF8 (path)).loadFileAsData (block))
    {
        *size = -1;
        return nullptr;
    }
    *size = (int) block.getSize();
    auto* out = malloc (juce::jmax ((size_t) 1, block.getSize()));
    memcpy (out, block.getData(), block.getSize());
    return out;
}

EMSCRIPTEN_KEEPALIVE int micfx_daw_remove (const char* path)
{
    const juce::File file (juce::String::fromUTF8 (path));
    return file.isDirectory() ? (file.deleteRecursively() ? 1 : 0) : (file.deleteFile() ? 1 : 0);
}

EMSCRIPTEN_KEEPALIVE int micfx_daw_mkdir (const char* path)
{
    return juce::File (juce::String::fromUTF8 (path)).createDirectory().wasOk() ? 1 : 0;
}

int main() { return 0; }
}
