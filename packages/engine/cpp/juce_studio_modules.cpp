// juce_events and juce_data_structures for analysis.wasm (and the DAW to come), patched for
// WebAssembly: messages and timers run when the page calls juce::wasmDispatchMessages().
// A unit of their own: juce_modules.cpp has the rest.
#include <juce_events/juce_events.cpp>
#include <juce_data_structures/juce_data_structures.cpp>
