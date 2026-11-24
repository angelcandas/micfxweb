#pragma once

// A stand-in for JUCE's juce_gui_basics, for daw.wasm only.
//
// The real module draws native windows and can't build for WebAssembly. The desktop DAW code
// (DawBridge, Practice, PluginProcessor) uses a handful of its names: file choosers, the
// instrument plug-in windows, the clipboard and JUCEApplicationBase::isStandaloneApp(). Here:
//
// - FileChooser asks the page (cpp/daw/DawHost.cpp sends "chooser" to the worker's JS, which
//   asks the page; the page's answer comes back as micfx_daw_chooser_result). The file the
//   person picks is copied into the browser's storage first, so juce::File reads it.
// - Windows (DocumentWindow, the generic editor) are never shown: the page draws its own.
// - SystemClipboard goes to the page too.
//
// If the desktop starts using more of the module, the web build fails to compile, and this
// file grows to match.

#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <juce_data_structures/juce_data_structures.h>
#include <juce_audio_processors/juce_audio_processors.h>

namespace juce
{
//==============================================================================
class Component
{
public:
    Component() = default;
    explicit Component (const String& name) : componentName (name) {}
    virtual ~Component() = default;

    void setVisible (bool shouldBeVisible)          { visible = shouldBeVisible; }
    bool isVisible() const noexcept                  { return visible; }
    void toFront (bool) {}
    void setSize (int w, int h)                      { width = w; height = h; }
    int getWidth() const noexcept                    { return width; }
    int getHeight() const noexcept                   { return height; }
    void centreWithSize (int w, int h)               { setSize (w, h); }
    const String& getName() const noexcept           { return componentName; }
    void setName (const String& n)                   { componentName = n; }
    bool isResizable() const noexcept                { return false; }

    template <class ComponentType>
    class SafePointer
    {
    public:
        SafePointer() = default;
        SafePointer (ComponentType* c) : comp (c) {}
        ComponentType* getComponent() const noexcept { return comp; }
        operator ComponentType*() const noexcept     { return comp; }
        ComponentType* operator->() const noexcept   { return comp; }
    private:
        ComponentType* comp = nullptr;
    };

private:
    String componentName;
    bool visible = false;
    int width = 0, height = 0;
};

/** Never shown on the web: the page draws each instrument's controls. */
class DocumentWindow : public Component
{
public:
    enum TitleBarButtons { minimiseButton = 1, maximiseButton = 2, closeButton = 4, allButtons = 7 };

    DocumentWindow (const String& title, Colour, int, bool = true) : Component (title) {}
    ~DocumentWindow() override = default;

    void setUsingNativeTitleBar (bool) {}
    void setResizable (bool, bool) {}
    void clearContentComponent()                     { content.reset(); }
    virtual void closeButtonPressed() {}

    template <typename Editor>
    void setContentOwned (Editor* editor, bool)
    {
        content.reset (editor);
        if (editor != nullptr)
            setSize (editor->getWidth(), editor->getHeight());
    }

private:
    struct Holder { virtual ~Holder() = default; };
    template <typename T> struct Owned : Holder { explicit Owned (T* t) : p (t) {} std::unique_ptr<T> p; };
    struct Content
    {
        template <typename T> void reset (T* t) { holder.reset (t == nullptr ? nullptr : new Owned<T> (t)); }
        void reset() { holder.reset(); }
        std::unique_ptr<Holder> holder;
    } content;
};

/** The generic editor: its size only (never shown). */
class GenericAudioProcessorEditor : public AudioProcessorEditor
{
public:
    explicit GenericAudioProcessorEditor (AudioProcessor& p) : AudioProcessorEditor (p) {}
    int getWidth() const noexcept  { return 400; }
    int getHeight() const noexcept { return 300; }
    bool isResizable() const noexcept { return true; }
};

//==============================================================================
class FileBrowserComponent
{
public:
    enum FileChooserFlags
    {
        openMode                = 1,
        saveMode                = 2,
        canSelectFiles          = 4,
        canSelectDirectories    = 8,
        canSelectMultipleItems  = 16,
        useTreeView             = 32,
        filenameBoxIsReadOnly   = 64,
        warnAboutOverwriting    = 128,
        doNotClearFileNameOnRootChange = 256
    };
};

class FileChooser;

namespace web
{
    // Asks the page (DawHost.cpp): `id` comes back with micfx_daw_chooser_result.
    void requestChooser (FileChooser&, const String& title, const File& start, const String& patterns, int flags);
    void cancelChooser (FileChooser&);
}

class FileChooser
{
public:
    FileChooser (const String& dialogBoxTitle, const File& initialFileOrDirectory = File(), const String& filePatternsAllowed = String(),
                 bool = true, bool = false, Component* = nullptr)
        : title (dialogBoxTitle), start (initialFileOrDirectory), patterns (filePatternsAllowed) {}

    ~FileChooser() { web::cancelChooser (*this); }

    void launchAsync (int flags, std::function<void (const FileChooser&)> callback)
    {
        done = std::move (callback);
        web::requestChooser (*this, title, start, patterns, flags);
    }

    File getResult() const                 { return results.isEmpty() ? File() : results.getReference (0); }
    Array<File> getResults() const         { return results; }
    URL getURLResult() const               { return URL (getResult()); }

    // The page's answer (DawHost.cpp): empty when the person cancelled.
    void finish (const Array<File>& picked)
    {
        results = picked;
        if (auto callback = std::move (done))
            callback (*this);
    }

private:
    String title;
    File start;
    String patterns;
    Array<File> results;
    std::function<void (const FileChooser&)> done;
};

//==============================================================================
namespace web { void copyToClipboard (const String&); }

struct SystemClipboard
{
    static void copyTextToClipboard (const String& text) { web::copyToClipboard (text); }
    static String getTextFromClipboard() { return {}; }
};

//==============================================================================
enum class MessageBoxIconType { NoIcon, QuestionIcon, WarningIcon, InfoIcon };
} // namespace juce
