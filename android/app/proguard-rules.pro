# Gomobile supplies consumer rules for go.** and tailnet.** in tailnet.aar.
# Keep callback members that native code invokes through their exported interfaces.
-keepclassmembers class * implements tailnet.Storage { public *; }
-keepclassmembers class * implements tailnet.Upload { public *; }

# JLaTeXMath expands built-in environments and commands through this reflected entry point.
-keep,allowoptimization class org.scilab.forge.jlatexmath.NewCommandMacro {
    public <init>();
    public java.lang.String executeMacro(org.scilab.forge.jlatexmath.TeXParser, java.lang.String[]);
}
