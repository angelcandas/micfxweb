// Desktop features with no browser version, so the desktop code that names them links:
// - Sockets: the local MCP server ("AI control") can't listen in a browser; it reports that
//   it couldn't start.
// - Web requests from C++ (the stem model download): the page fetches what it needs itself.
// - The desktop editor window (the page is the editor).
#include <juce_core/juce_core.h>
#include "PluginProcessor.h"

namespace juce
{
StreamingSocket::StreamingSocket() {}
StreamingSocket::~StreamingSocket() {}
void StreamingSocket::close() {}
bool StreamingSocket::createListener (int, const String&) { return false; }
int StreamingSocket::getBoundPort() const noexcept { return -1; }
int StreamingSocket::read (void*, int, bool) { return -1; }
int StreamingSocket::write (const void*, int) { return -1; }
StreamingSocket* StreamingSocket::waitForNextConnection() const { return nullptr; }
int StreamingSocket::waitUntilReady (bool, int) { return -1; }

class WebInputStream::Pimpl {};
WebInputStream::WebInputStream (const URL&, bool) {}
WebInputStream::~WebInputStream() {}
int64 WebInputStream::getTotalLength() { return 0; }
int WebInputStream::read (void*, int) { return 0; }
bool WebInputStream::isExhausted() { return true; }
int64 WebInputStream::getPosition() { return 0; }
bool WebInputStream::setPosition (int64) { return false; }
WebInputStream& WebInputStream::withExtraHeaders (const String&) { return *this; }
WebInputStream& WebInputStream::withCustomRequestCommand (const String&) { return *this; }
WebInputStream& WebInputStream::withConnectionTimeout (int) { return *this; }
WebInputStream& WebInputStream::withNumRedirectsToFollow (int) { return *this; }
StringPairArray WebInputStream::getResponseHeaders() { return {}; }
int WebInputStream::getStatusCode() { return 0; }
bool WebInputStream::connect (Listener*) { return false; }
bool WebInputStream::isError() const { return true; }
bool WebInputStream::Listener::postDataSendProgress (WebInputStream&, int, int) { return true; }
} // namespace juce

juce::AudioProcessorEditor* PluginProcessor::createEditor() { return nullptr; }
