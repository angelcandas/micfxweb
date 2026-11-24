// JUCE's WebAssembly build reads and writes files but leaves out folders, links, copying and the
// special locations. These are its Linux versions, on Emscripten's file system (the home
// folder is the browser's private storage: see micfx_daw_mount in DawHost.cpp).
#include <juce_core/juce_core.h>

#include <dirent.h>
#include <fnmatch.h>
#include <sys/stat.h>
#include <unistd.h>

namespace juce
{
bool File::copyInternal (const File& dest) const
{
    FileInputStream in (*this);

    if (dest.deleteFile())
    {
        {
            FileOutputStream out (dest);
            if (out.failedToOpen())
                return false;
            if (out.writeFromInputStream (in, -1) == getSize())
                return true;
        }
        dest.deleteFile();
    }
    return false;
}

void File::findFileSystemRoots (Array<File>& destArray) { destArray.add (File ("/")); }
bool File::isHidden() const                              { return getFileName().startsWithChar ('.'); }
bool File::isSymbolicLink() const                        { return getNativeLinkedTarget().isNotEmpty(); }

String File::getNativeLinkedTarget() const
{
    char buffer[4096];
    const auto numBytes = (int) readlink (getFullPathName().toRawUTF8(), buffer, sizeof (buffer) - 2);
    return String::fromUTF8 (buffer, jmax (0, numBytes));
}

static File homeFolder()
{
    if (const char* home = getenv ("HOME"))
        return File (CharPointer_UTF8 (home));
    return File ("/home/web");
}

File File::getSpecialLocation (const SpecialLocationType type)
{
    switch (type)
    {
        case userHomeDirectory:              return homeFolder();
        case userDocumentsDirectory:         return homeFolder().getChildFile ("Documents");
        case userMusicDirectory:             return homeFolder().getChildFile ("Music");
        case userMoviesDirectory:            return homeFolder().getChildFile ("Videos");
        case userPicturesDirectory:          return homeFolder().getChildFile ("Pictures");
        case userDesktopDirectory:           return homeFolder().getChildFile ("Desktop");
        case userApplicationDataDirectory:   return homeFolder().getChildFile (".config");
        case commonDocumentsDirectory:
        case commonApplicationDataDirectory: return homeFolder().getChildFile (".common");
        case globalApplicationsDirectory:    return File ("/usr");
        case tempDirectory:                  return File ("/tmp");
        case invokedExecutableFile:
        case currentExecutableFile:
        case currentApplicationFile:
        case hostApplicationPath:            return File ("/micfx/daw.wasm");
        default:                             break;
    }
    return {};
}

String File::getVersion() const                  { return {}; }
bool File::moveToTrash() const                   { return deleteRecursively(); }
void File::revealToUser() const {}
bool Process::openDocument (const String&, const String&) { return false; }

//==============================================================================
class DirectoryIterator::NativeIterator::Pimpl
{
public:
    Pimpl (const File& directory, const String& wc)
        : parentDir (File::addTrailingSeparator (directory.getFullPathName())),
          wildCard (wc), dir (opendir (directory.getFullPathName().toUTF8())) {}

    ~Pimpl()
    {
        if (dir != nullptr)
            closedir (dir);
    }

    bool next (String& filenameFound, bool* isDir, bool* isHidden, int64* fileSize,
               Time* modTime, Time* creationTime, bool* isReadOnly)
    {
        if (dir == nullptr)
            return false;

        const auto pattern = wildCard.toStdString();
        while (auto* de = readdir (dir))
        {
            if (fnmatch (pattern.c_str(), de->d_name, FNM_CASEFOLD) != 0)
                continue;

            filenameFound = CharPointer_UTF8 (de->d_name);
            if (filenameFound == "." || filenameFound == "..")
                continue;

            struct stat info {};
            const auto ok = stat ((parentDir + filenameFound).toRawUTF8(), &info) == 0;
            if (isDir != nullptr)        *isDir = ok && S_ISDIR (info.st_mode);
            if (fileSize != nullptr)     *fileSize = ok ? (int64) info.st_size : 0;
            if (modTime != nullptr)      *modTime = Time (ok ? (int64) info.st_mtime * 1000 : 0);
            if (creationTime != nullptr) *creationTime = Time (ok ? (int64) info.st_ctime * 1000 : 0);
            if (isReadOnly != nullptr)   *isReadOnly = false;
            if (isHidden != nullptr)     *isHidden = filenameFound.startsWithChar ('.');
            return true;
        }
        return false;
    }

private:
    String parentDir, wildCard;
    DIR* dir;
};

DirectoryIterator::NativeIterator::NativeIterator (const File& directory, const String& wildCardStr)
    : pimpl (new Pimpl (directory, wildCardStr)) {}

DirectoryIterator::NativeIterator::~NativeIterator() {}

bool DirectoryIterator::NativeIterator::next (String& filenameFound, bool* isDir, bool* isHidden, int64* fileSize,
                                              Time* modTime, Time* creationTime, bool* isReadOnly)
{
    return pimpl->next (filenameFound, isDir, isHidden, fileSize, modTime, creationTime, isReadOnly);
}
} // namespace juce
