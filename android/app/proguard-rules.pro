# Gomobile supplies consumer rules for go.** and tailnet.** in tailnet.aar.
# Keep callback members that native code invokes through their exported interfaces.
-keepclassmembers class * implements tailnet.Storage { public *; }
-keepclassmembers class * implements tailnet.Upload { public *; }
