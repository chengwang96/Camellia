package app.camellia.mobile;

final class NetworkRoute {
    private Object network;
    private String links;
    private long revision;

    NetworkRoute(Object network, String links) { this.network = network; this.links = links; }

    synchronized boolean available(Object value) {
        if (java.util.Objects.equals(network, value)) return false;
        network = value; links = null; revision++; return true;
    }

    synchronized boolean links(Object value, String properties) {
        if (!java.util.Objects.equals(network, value) || java.util.Objects.equals(links, properties)) return false;
        links = properties; revision++; return true;
    }

    synchronized boolean lost(Object value) {
        if (!java.util.Objects.equals(network, value)) return false;
        network = null; links = null; revision++; return true;
    }

    synchronized long revision() { return revision; }
    synchronized boolean online() { return network != null; }
}
